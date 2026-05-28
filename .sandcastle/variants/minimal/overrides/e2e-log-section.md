# TEST LOG — only present if the implementer ran the project's test runner
# Bounded to the last 50KB. Huge logs (e.g. failing tests with deep stack
# traces and fixture dumps) used to blow the reviewer's context window
# at ~116k tokens and crash this prompt with "Prompt is too long" — the
# tail keeps the actually-useful tail-of-run output (failures, summary).

<test-log>

!`if [ -f /tmp/sandcastle-test-it{{ITERATION}}.log ]; then node -e "const fs=require('fs');const p='/tmp/sandcastle-test-it{{ITERATION}}.log';const s=fs.readFileSync(p,'utf8');const LIMIT=50000;if(s.length>LIMIT){const nl=s.indexOf('\n',s.length-LIMIT);const cut=nl>=0?nl+1:s.length-LIMIT;process.stdout.write('[test log truncated — original size '+Buffer.byteLength(s,'utf8')+' bytes, '+s.length+' chars, showing last '+(s.length-cut)+' chars from newline boundary]\n'+s.slice(cut));}else{process.stdout.write(s);}"; else echo "(no /tmp/sandcastle-test-it{{ITERATION}}.log present — implementer did not run the test suite)"; fi`

</test-log>
