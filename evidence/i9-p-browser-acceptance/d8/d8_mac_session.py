"""Interactive wrapper around the previously published exact-B1 synthetic stand."""
import argparse
import datetime
import hashlib
import json
import os
import plistlib
from pathlib import Path
import re
import selectors
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

B1 = '3a0cb5db434032b3f7b6370c305c558a4b5d331c'
PUBLISHED = {
    'd8_operator.py': '4d2e9b91bc2a9049cc82f3ecd39ddc1b8c172dd695b97fbac41059abc1a126dd',
    'stand/d8_stand.py': '7b602fcfad44c687f208c379cdd1345c3beb12f2031f74cbc1d2e8180ba2e522',
    'stand/launch-d8.sh': '4391f8e678a1639abfce89fe60b37e844c5789b69c10eba61d4bb8b9f6ecc292',
}
STEPS_SHA = '3128a53b9a8ce4f7ce2b4015e15b621ca999285941ce7fac67f76b0b9f99bac8'
SCENARIOS = (
    ('D8-NAV-01', ('Back/Forward: восемь вкладок, календарь, аналитика и Reload',)),
    ('D8-NAV-02', ('skip link, диалог, Escape и reduced motion выключен',
                   'skip link, диалог, Escape и reduced motion включен',
                   'адаптивная панель: активация и закрытие, включая касание на устройстве где применимо')),
    ('D8-TAB-01', ('обзор: doctor', 'обзор: уполномоченная read-only роль', 'обзор: другое отделение')),
    ('D8-TAB-02', ('уведомления и обновление', 'непустая история и ограниченная роль')),
    ('D8-TAB-03', ('данные: ошибка и единственное явное сохранение',)),
    ('D8-TAB-04', ('комментарий: явная запись и перечитывание',)),
    ('D8-TAB-05', ('события: плановая дата и отказ фактической даты',)),
    ('D8-TAB-06', ('чек-лист: единственный флажок и read-only история',)),
    ('D8-TAB-07', ('заметка: отмена ухода, подтвержденный уход и явное сохранение',)),
    ('D8-TAB-08', ('история: порядок, дата, статус, предусмотренная версия и read-only',)),
    ('D8-KEY-01', ('восемь вкладок: стрелки/Home/End, Enter/Space, Tab/Shift+Tab',)),
    ('D8-LOSS-01', ('Новый пациент: отказ транспорта, восстановление и черновик',
                    'Консилиум: слот, отказ транспорта, восстановление и черновик')),
    ('D8-DRAFT-01', ('черновик: отмена и подтверждение ухода', 'реальный 409: две независимые сессии')),
    ('D8-SESSION-01', ('вход той же личности', 'чужая личность во второй вкладке',
                       'серверный 401', 'серверный объектный отзыв', 'реальный запоздалый 200')),
    ('D8-QUALITY-01', ('нативный Safari Page Zoom 100%', 'нативный Safari Page Zoom 200%',
                       'нативный Safari Page Zoom 400%')),
    ('D8-WIDTH-01', ('320 CSS px: две ориентации', '375 CSS px: две ориентации',
                     '768 CSS px: две ориентации', '1440 CSS px: desktop')),
)
THEMES = ('light', 'dark')
STATUSES = {'P': 'PASS', 'F': 'FAIL', 'B': 'BLOCKED', 'N': 'NOT TESTED'}
CLEAN_FIELDS = ('cleanExit', 'listenerClosed', 'scratchRemoved', 'fixtureRemoved')
NEVER_LOG = re.compile(
    r'https?://|(?:/|\\)(?:Users|tmp|home|private)[/\\]|'
    r'\b(?:Bearer|authorization|password|cookie|token|пароль|токен)\b|'
    r'[^\s@]+@[^\s@]+|[0-9a-f]{8}-[0-9a-f-]{20,}|\d{6,}', re.I,
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_inputs(kit, steps):
    for relative, expected in PUBLISHED.items():
        if digest(kit / relative) != expected:
            raise ValueError(f'файл опубликованного стенда изменился: {relative}')
    if digest(steps) != STEPS_SHA:
        raise ValueError('изменились опубликованные сценарии')
    lines = steps.read_text().splitlines()
    table = [tuple(column.strip() for column in line.split('|')[1:-1]) for line in lines
             if re.match(r'^\| \d+ \| D8-', line)]
    if [row[1] for row in table] != [name for name, _ in SCENARIOS]:
        raise ValueError('сценарии не совпадают с утвержденной последовательностью')
    return {row[1]: row[2:] for row in table}


def platform():
    if sys.platform != 'darwin':
        raise ValueError('для операторского сеанса требуется Mac')
    safari_options = [Path('/Applications/Safari.app'), Path('/System/Applications/Safari.app')]
    safari = next((path for path in safari_options if path.is_dir()), None)
    voiceover = Path('/System/Library/CoreServices/VoiceOver.app')
    if safari is None or not voiceover.is_dir():
        raise ValueError('требуются Safari и VoiceOver')
    result = {}
    for name, app in [('safari', safari), ('voiceOver', voiceover)]:
        data = plistlib.loads((app / 'Contents' / 'Info.plist').read_bytes())
        result[name] = {'version': data['CFBundleShortVersionString'],
                        'build': data['CFBundleVersion']}
    result['macOS'] = {
        'version': subprocess.check_output(['/usr/bin/sw_vers', '-productVersion'],
                                           text=True, timeout=4).strip(),
        'build': subprocess.check_output(['/usr/bin/sw_vers', '-buildVersion'],
                                         text=True, timeout=4).strip(),
    }
    return safari, result


def ready_fixture(process, port):
    exact_url = f'http://127.0.0.1:{port}/'
    with selectors.DefaultSelector() as sel:
        sel.register(process.stdout, selectors.EVENT_READ)
        pending = b''
        fixture = None
        url_ready = False
        deadline = time.monotonic() + 68
        while time.monotonic() < deadline:
            if process.poll() is not None:
                break
            if not sel.select(timeout=min(0.5, max(0, deadline - time.monotonic()))):
                continue
            chunk = os.read(process.stdout.fileno(), 4096)
            if not chunk:
                break
            pending += chunk
            if len(pending) > 16384:
                raise ValueError('неожиданный вывод launcher')
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                line = line.decode('utf-8')
                if line == f'Стенд B1 готов. Safari: {exact_url}':
                    url_ready = True
                elif line.startswith('Фикстура только локально: '):
                    path = Path(line.removeprefix('Фикстура только локально: '))
                    if (path.is_symlink() or path.name != 'fixture.json'
                            or path.parent.parent.resolve() != Path('/tmp').resolve()
                            or not path.parent.name.startswith('clinic-d8-')):
                        raise ValueError('неожиданный путь фикстуры')
                    fixture = path
            if url_ready and fixture:
                return exact_url, fixture
    raise ValueError('проверенный loopback не перешел в готовое состояние')


def cleanup(result):
    return all(result.get(key) is True for key in CLEAN_FIELDS) and result.get('exactProductSha') == B1


def ready_browser(safari, url, port):
    if url != f'http://127.0.0.1:{port}/':
        raise ValueError('допускается только точный URL синтетического стенда')
    subprocess.run(['/usr/bin/open', '-a', str(safari), url], check=True, timeout=10)


def write_json(path, data):
    with path.open('x', encoding='utf-8') as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
        file.write('\n')


def utc():
    return datetime.datetime.now(datetime.UTC).isoformat()


def text_observation(prompt):
    while True:
        value = input(prompt).strip()
        if 0 < len(value) <= 180 and not NEVER_LOG.search(value):
            return value
        print('Введите короткое наблюдение без ссылок, имен, идентификаторов и учетных данных.')


def coverage(rows):
    observed = {(row['scenario'], row['theme'], row['case']): row['status'] for row in rows}
    result = {}
    for scenario, cases in SCENARIOS:
        values = [observed.get((scenario, theme, index), 'NOT TESTED')
                  for theme in THEMES for index in range(1, len(cases) + 1)]
        if 'FAIL' in values:
            result[scenario] = 'FAIL'
        elif all(value == 'PASS' for value in values):
            result[scenario] = 'PASS'
        elif 'BLOCKED' in values:
            result[scenario] = 'BLOCKED'
        else:
            result[scenario] = 'NOT TESTED'
    return result


def observe(table, rows, ledger, process, start_scenario):
    print('В Safari включите VoiceOver (Command+F5), Tab по всем элементам и обе темы.')
    print('Сопоставляйте Tab-фокус и курсор VoiceOver. Поля должны исключать данные фикстуры.')
    print('P = PASS, F = FAIL, B = BLOCKED, N/Enter = NOT TESTED, Q = завершить. Ctrl+C останавливает стенд.')
    started = False
    for position, (scenario, cases) in enumerate(SCENARIOS, 1):
        started = started or scenario == start_scenario
        if not started:
            continue
        action, expectation = table[scenario]
        print(f'\n[{position}/16] {scenario}\nДействие: {action}\nКритерий: {expectation}')
        for theme in THEMES:
            for index, case in enumerate(cases, 1):
                if process.poll() is not None:
                    raise ValueError('сервер завершился во время ручной проверки')
                while True:
                    selected = input(f'{theme} / {case} [P/F/B/N/Q]: ').strip().upper() or 'N'
                    if selected == 'Q':
                        return
                    if selected in STATUSES:
                        break
                status = STATUSES[selected]
                row = {'scenario': scenario, 'theme': theme, 'case': index,
                       'status': status, 'recordedAtUTC': utc()}
                if status in ('PASS', 'FAIL'):
                    print('Подтвердите наблюдение лично. Примеры: «объявлено Ошибка», «фокус вернулся на вкладку».')
                    row['spoken'] = text_observation('Услышанное объявление VoiceOver: ')
                    row['focus'] = text_observation('Фактический фокус: ')
                    row['result'] = text_observation('Действие, ожидаемый и фактический результат: ')
                    row['environment'] = text_observation('Роль, CSS-ширина, нативный масштаб и настройки клавиатуры: ')
                    row['clinicalWrites'] = text_observation('Ожидаемые и наблюдаемые записи, укажите количество: ')
                    if status == 'PASS' and input('Лично услышано, проверены все критерии подслучая? [yes/НЕТ] ').strip().lower() != 'yes':
                        row['status'] = 'NOT TESTED'
                elif status == 'BLOCKED':
                    row['reason'] = text_observation('Точная отсутствующая предпосылка: ')
                rows.append(row)
                ledger.write(json.dumps(row, ensure_ascii=False) + '\n')
                ledger.flush()
                os.fsync(ledger.fileno())


def manual_session(args, safari, info, table, session):
    rows = []
    receipt_path = session / 'D8_TECHNICAL_PRIVATE.json'
    process = subprocess.Popen([sys.executable, '-I', '-B', str(args.kit / 'd8_operator.py'),
                                str(args.app), '--port', str(args.port), '--receipt', str(receipt_path)],
                               stdout=subprocess.PIPE, start_new_session=True)
    issue = False
    try:
        url, fixture = ready_fixture(process, args.port)
        print(f'Синтетическая фикстура только локально, до остановки: {shlex.quote(str(fixture))}')
        launch = input('Подготовили отдельный профиль Safari без синхронизации и расширений? [yes/НЕТ] ')
        if launch.strip().lower() != 'yes':
            raise ValueError('оператор не подтвердил готовность выделенного профиля Safari')
        ready_browser(safari, url, args.port)
        with (session / 'D8_OPERATOR_PRIVATE.jsonl').open('x', encoding='utf-8') as ledger:
            observe(table, rows, ledger, process, args.start_scenario)
    except (EOFError, KeyboardInterrupt):
        print('\nСеанс прерван оператором. Сохраненные наблюдения остаются локально.')
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        issue = True
        print(f'Операторский сеанс остановлен: {type(error).__name__}', file=sys.stderr)
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.communicate(timeout=35)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
        try:
            technical = json.loads(receipt_path.read_bytes())
            stopped = process.returncode == 0 and cleanup(technical)
        except (OSError, ValueError, TypeError):
            stopped = False
        write_json(session / 'D8_SESSION_PRIVATE.json', {
            'productSha': B1, 'platform': info, 'recordedSubcases': len(rows),
            'scenarios': coverage(rows), 'verifiedShutdown': stopped,
            'requiresHumanReviewBeforePublication': True,
        })
    print(f'Локальные результаты: {session}')
    if not stopped:
        print('Штатное завершение не подтверждено. Проверьте локальный стенд перед новым сеансом.')
    return 0 if stopped and not issue else 1


def smoke(args, info, session):
    result_path = session / 'D8_TECHNICAL_PRIVATE.json'
    res = subprocess.run([sys.executable, '-I', '-B', str(args.kit / 'd8_operator.py'),
                          str(args.app), '--port', str(args.port), '--receipt', str(result_path), '--smoke'],
                         check=True, stdout=subprocess.DEVNULL, timeout=105)
    result = json.loads(result_path.read_bytes())
    if res.returncode or not cleanup(result) or (
        result.get('healthHttp'), result.get('htmlHttp'), result.get('syntheticPatients'),
        result.get('manualResultsRecorded'),
    ) != (200, 200, 240, 0):
        raise ValueError('не подтверждены технические критерии')
    result.pop('listener', None)
    result.update(platform=info, browserOpened=False, manualVoiceOverHeard=False, operatorScenarioCount=16)
    write_json(session / 'D8_TECHNICAL_SAFE.json', result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0



def keyboard_session(args, session):
    node = shutil.which('node')
    if node is None:
        raise ValueError('для автоматической проверки требуется Node.js')
    receipt_path = session / 'D8_TECHNICAL_PRIVATE.json'
    process = subprocess.Popen([sys.executable, '-I', '-B', str(args.kit / 'd8_operator.py'),
                                str(args.app), '--port', str(args.port), '--receipt', str(receipt_path)],
                               stdout=subprocess.PIPE, start_new_session=True)
    try:
        url, fixture = ready_fixture(process, args.port)
        check = subprocess.check_output([node, str(Path(__file__).with_name('d8_keyboard_check.cjs')),
                                         url, str(fixture)], text=True, timeout=45)
    finally:
        if process.poll() is None:
            process.terminate()
        process.communicate(timeout=35)
    result = json.loads(receipt_path.read_bytes())
    if process.returncode or not cleanup(result):
        raise ValueError('завершение клавиатурной проверки не подтверждено')
    payload = json.loads(check)
    payload.update(productSha=B1, cleanExit=True, manualResultsRecorded=0)
    write_json(session / 'D8_KEYBOARD_SAFE.json', payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('app', 'kit', 'steps', 'output'):
        parser.add_argument('--' + key, type=Path, required=True)
    parser.add_argument('--port', type=int, default=19089)
    parser.add_argument('--start-scenario', choices=[name for name, _ in SCENARIOS],
                        default=SCENARIOS[0][0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--technical-check', action='store_true')
    mode.add_argument('--keyboard-check', action='store_true')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('нужен непривилегированный порт')
    if not args.technical_check and not args.keyboard_check and not sys.stdin.isatty():
        parser.error('ручной режим требует интерактивного терминала')
    os.umask(0o077)
    try:
        for name in ('app', 'kit', 'steps', 'output'):
            setattr(args, name, getattr(args, name).resolve(strict=True))
        table = check_inputs(args.kit, args.steps)
        safari, info = platform()
        session = Path(tempfile.mkdtemp(prefix='i9-d8-session-', dir=args.output))
        if args.technical_check:
            return smoke(args, info, session)
        if args.keyboard_check:
            return keyboard_session(args, session)
        signal.signal(signal.SIGTERM, lambda *_: signal.raise_signal(signal.SIGINT))
        return manual_session(args, safari, info, table, session)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f'D8 BLOCKED: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
