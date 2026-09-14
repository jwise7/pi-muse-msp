#!/usr/bin/env python3
"""Isolated MSP regressions; no real Muse, approval decisions, or live sessions."""
import os
from pathlib import Path
import subprocess
import tempfile

here = Path(__file__).resolve().parent
extension = here.parents[1] / 'extensions/muse-msp.ts'

def check(flags, expected, starts, decisions=0, failed=False):
    with tempfile.TemporaryDirectory(prefix='msp-check-') as tmp:
        log = Path(tmp) / 'calls'
        env = {k: v for k, v in os.environ.items() if not k.startswith('FAKE_')}
        env.update(HOME=tmp, PI_MUSE_BINARY=str(here / 'fake-host.py'), FAKE_MSP_LOG=str(log), **flags)
        result = subprocess.run(['pi', '--no-session', '--no-extensions', '-e', str(extension),
            '--provider', 'muse-msp', '--model', 'muse-spark-1.3', '--no-tools', '-p', 'Test request'],
            env=env, text=True, capture_output=True, timeout=20)
        assert expected in result.stdout + result.stderr, (result.stdout, result.stderr)
        if not failed:
            assert result.returncode == 0, result.stderr
        calls = log.read_text().splitlines()
        assert calls.count('session/start') == starts, calls
        assert calls.count('session/start provider=meta') == starts, calls
        assert calls.count('turn/start') == starts, calls
        assert calls.count('approval/decide') == decisions, calls
        assert 'turn/cancel' not in calls, calls

check({'FAKE_MEDIA_EVENT': '1', 'FAKE_REASONING': '1'}, 'VISIBLE-ANSWER', 2)
check({'FAKE_MEDIA_EVENT': '1', 'FAKE_MEDIA_ALWAYS': '1'}, 'retained media history', 2, failed=True)
check({'FAKE_APPROVAL': '1'}, 'AUTO-APPROVED', 1, decisions=1)
check({'FAKE_APPROVAL': '1', 'FAKE_ALREADY_RESOLVED': '1'}, 'AUTO-APPROVED', 1, decisions=1)
check({'FAKE_APPROVAL': '1', 'FAKE_APPROVAL_DRIFT': '1'}, 'AUTO-APPROVED', 1, decisions=1)
subprocess.run(['python3', str(here / 'vision-retry.py')], check=True, timeout=25)
subprocess.run(['python3', str(here / 'salvage-fresh.py')], check=True, timeout=25)
print('PASS: event recovery, bounded repeated failure, duplicate/resolved approvals, image log recovery')
