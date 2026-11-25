"""Apply the observation overlay to the exact synthetic harness only."""
from pathlib import Path
import sys

case = Path("tools/tests/wp_i_workspace")
source = Path(sys.argv[1]).resolve(strict=True)


def replace(path, old, new):
    text = path.read_text()
    if text.count(old) != 1:
        raise SystemExit("workspace observation anchor mismatch")
    path.write_text(text.replace(old, new))


def js_path(name):
    import json
    return json.dumps(str(source / name))


flow = case / "workflows.cjs"
anchor = """await p.locator('#loginSubmit').click();await p.waitForFunction(()=>app.appReady&&!app.sessionExpired);await enter(p,'calendar');await search('events',f.patient.name);"""
replacement = f"""const wsTrace=await require({js_path('timeline.cjs')}).install(p);
try {{
await wsTrace.sample('wait-start');
await p.locator('#loginSubmit').click();await p.waitForFunction(()=>app.appReady&&!app.sessionExpired);
await enter(p,'calendar');
}} catch(error) {{ await wsTrace.sample('wait-error'); throw error; }}
finally {{ await wsTrace.finish(); }}
await search('events',f.patient.name);"""
replace(flow, anchor, replacement)
server = case / "server.py"
replace(server, "    return original(measured,*args,**kwargs)",
        f"""    sys.path.insert(0,{str(source)!r})
    from backend_probe import serve
    return serve(original,measured,previous,*args,**kwargs)""")
