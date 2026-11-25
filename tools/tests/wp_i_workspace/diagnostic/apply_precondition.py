"""Temporary Workspace test patch. No edits to product or existing assertions."""
import json
from pathlib import Path
import sys

path = Path("tools/tests/wp_i_workspace/workflows.cjs")
source = Path(sys.argv[1]).resolve(strict=True)
text = path.read_text()

def add(before, new):
    global text
    if text.count(before) != 1:
        raise SystemExit("workspace precondition anchor mismatch")
    text = text.replace(before, new + "\n" + before)

add("let writes=0,objectGets=0", f"const wsPrecondition=require({json.dumps(str(source/'quiesce.cjs'))});await wsPrecondition.watch(p);")
add("await enter(p,'calendar');let req,rel;", "await wsPrecondition.waitForExistingAuditedReads(p);")
add("\nawait enter(p,'calendar');\n} catch(error)", "await wsPrecondition.waitForExistingAuditedReads(p);")
path.write_text(text)
