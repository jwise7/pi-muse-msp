#!/usr/bin/env python3
"""Isolated MSP regressions; no real Muse, approval decisions, or live sessions."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

here = Path(__file__).resolve().parent
extension = here.parents[1] / 'extensions/muse-msp.ts'

def check_version_sync():
    pkg = json.loads((here.parents[1] / 'package.json').read_text())
    match = re.search(r'^const CLIENT_VERSION = "([^"]+)";', extension.read_text(), re.M)
    assert match, 'CLIENT_VERSION not found in extension'
    assert pkg['version'] == match.group(1), (pkg['version'], match.group(1))

def check(flags, expected, starts, decisions=0, failed=False, extra_args=()):
    with tempfile.TemporaryDirectory(prefix='msp-check-') as tmp:
        log = Path(tmp) / 'calls'
        env = {k: v for k, v in os.environ.items() if not k.startswith('FAKE_')}
        env.update(HOME=tmp, PI_MUSE_BINARY=str(here / 'fake-host.py'), FAKE_MSP_LOG=str(log), **flags)
        result = subprocess.run(['pi', '--no-session', '--no-extensions', '-e', str(extension),
            '--provider', 'muse-msp', '--model', 'muse-spark-1.3', '--no-tools', *extra_args,
            '-p', 'Test request'], env=env, text=True, capture_output=True, timeout=20)
        assert expected in result.stdout + result.stderr, (result.stdout, result.stderr)
        if not failed:
            assert result.returncode == 0, result.stderr
        calls = log.read_text().splitlines()
        assert calls.count('session/start') == starts, calls
        assert calls.count('session/start provider=meta') == starts, calls
        assert calls.count('turn/start') == starts, calls
        assert calls.count('approval/decide') == decisions, calls
        assert 'turn/cancel' not in calls, calls


def check_compaction_context():
    with tempfile.TemporaryDirectory(prefix='msp-compaction-') as tmp:
        tmp = Path(tmp)
        log = tmp / 'calls'
        injector = tmp / 'inject-compaction.ts'
        injector.write_text('''
export default function injectCompaction(pi: any): void {
  pi.on("context", (event: any) => ({
    messages: [
      { role: "compactionSummary", summary: "Earlier compacted work", tokensBefore: 1234, timestamp: Date.now() },
      ...event.messages,
    ],
  }));
}
''')
        env = {k: v for k, v in os.environ.items() if not k.startswith('FAKE_')}
        env.update(HOME=str(tmp), PI_MUSE_BINARY=str(here / 'fake-host.py'),
                   FAKE_MSP_LOG=str(log), FAKE_REASONING='1')
        result = subprocess.run([
            'pi', '--no-session', '--no-extensions', '-e', str(injector), '-e', str(extension),
            '--provider', 'muse-msp', '--model', 'muse-spark-1.3', '--no-tools',
            '-p', 'Compaction bridge test',
        ], env=env, text=True, capture_output=True, timeout=20)
        output = result.stdout + result.stderr
        assert result.returncode == 0, output
        assert 'VISIBLE-ANSWER' in output, output
        assert "Cannot read properties of undefined (reading 'map')" not in output, output
        assert 'Extension "' not in output, output


def check_user_input():
    # Headless clarification path: no Pi UI, so the extension must cancel the
    # prompt server-side and fail the turn with an actionable notice.
    with tempfile.TemporaryDirectory(prefix='msp-userinput-') as tmp:
        log = Path(tmp) / 'calls'
        env = {k: v for k, v in os.environ.items() if not k.startswith('FAKE_')}
        env.update(HOME=tmp, PI_MUSE_BINARY=str(here / 'fake-host.py'),
                   FAKE_MSP_LOG=str(log), FAKE_USER_INPUT='1')
        result = subprocess.run(['pi', '--no-session', '--no-extensions', '-e', str(extension),
            '--provider', 'muse-msp', '--model', 'muse-spark-1.3', '--no-tools',
            '-p', 'Test request'], env=env, text=True, capture_output=True, timeout=20)
        output = result.stdout + result.stderr
        assert 'Muse asked a clarifying question; answer it in chat and retry' in output, output
        assert result.returncode != 0, output
        calls = log.read_text().splitlines()
        assert calls.count('turn/start') == 1, calls
        assert 'userInput/cancel' in calls, calls


def check_hang_start():
    # A host that never acks session/start must fail the turn after two
    # bounded attempts, not hang forever (no salvage timer exists yet).
    # Agent-level retries are disabled so the attempt count is exact.
    with tempfile.TemporaryDirectory(prefix='msp-hangstart-') as tmp:
        log = Path(tmp) / 'calls'
        agent_dir = Path(tmp) / '.pi' / 'agent'
        agent_dir.mkdir(parents=True)
        (agent_dir / 'settings.json').write_text(json.dumps({"retry": {"maxRetries": 0}}))
        env = {k: v for k, v in os.environ.items() if not k.startswith('FAKE_')}
        env.update(HOME=tmp, PI_MUSE_BINARY=str(here / 'fake-host.py'),
                   FAKE_MSP_LOG=str(log), FAKE_HANG_START='1')
        result = subprocess.run(['pi', '--no-session', '--no-extensions', '-e', str(extension),
            '--provider', 'muse-msp', '--model', 'muse-spark-1.3', '--no-tools',
            '-p', 'Test request'], env=env, text=True, capture_output=True, timeout=30)
        output = result.stdout + result.stderr
        assert 'session/start timed out' in output, output
        assert result.returncode != 0, output
        calls = log.read_text().splitlines()
        assert calls.count('session/start') == 2, calls


def check_modellist_hang():
    # A host that never answers model/list must fall back to the static
    # models and run the turn, not hang model refresh.
    with tempfile.TemporaryDirectory(prefix='msp-modellist-') as tmp:
        log = Path(tmp) / 'calls'
        env = {k: v for k, v in os.environ.items() if not k.startswith('FAKE_')}
        env.update(HOME=tmp, PI_MUSE_BINARY=str(here / 'fake-host.py'),
                   FAKE_MSP_LOG=str(log), FAKE_HANG_MODELLIST='1', FAKE_REASONING='1')
        result = subprocess.run(['pi', '--no-session', '--no-extensions', '-e', str(extension),
            '--provider', 'muse-msp', '--model', 'muse-spark-1.3', '--no-tools',
            '-p', 'Test request'], env=env, text=True, capture_output=True, timeout=30)
        output = result.stdout + result.stderr
        assert result.returncode == 0, output
        assert 'VISIBLE-ANSWER' in output, output
        calls = log.read_text().splitlines()
        assert 'model/list' in calls, calls


def check_trust_args():
    # Both postures load workspace skills and rules; only the default
    # posture disables the sandbox. Pi applies CLI flags after the startup
    # model refresh, so refresh spawns safe: sandboxed when posture is
    # unknown, reusing any existing host (never respawning to list models).
    # Sandboxed run: one host, never --disable-sandbox (the old #3 bug was
    # an unsandboxed refresh host here). Default run: refresh spawns
    # sandboxed, then the turn respawns once under its real posture.
    for extra in ((), ('--muse-msp-sandboxed',)):
        with tempfile.TemporaryDirectory(prefix='msp-argv-') as tmp:
            log = Path(tmp) / 'calls'
            env = {k: v for k, v in os.environ.items() if not k.startswith('FAKE_')}
            env.update(HOME=tmp, PI_MUSE_BINARY=str(here / 'fake-host.py'),
                       FAKE_MSP_LOG=str(log), FAKE_REASONING='1')
            result = subprocess.run(['pi', '--no-session', '--no-extensions', '-e', str(extension),
                '--provider', 'muse-msp', '--model', 'muse-spark-1.3', '--no-tools', *extra,
                '-p', 'Test request'], env=env, text=True, capture_output=True, timeout=20)
            output = result.stdout + result.stderr
            assert result.returncode == 0, output
            assert 'VISIBLE-ANSWER' in output, output
            argv = [line for line in log.read_text().splitlines() if line.startswith('argv:')]
            assert argv, 'fake host did not log argv'
            assert all('--trust-workspace' in line for line in argv), argv
            if extra:
                assert len(argv) == 1, argv
                assert '--disable-sandbox' not in argv[0], argv
            else:
                assert len(argv) == 2, argv
                assert '--disable-sandbox' not in argv[0], argv
                assert '--disable-sandbox' in argv[-1], argv


check_version_sync()
check({'FAKE_MEDIA_EVENT': '1', 'FAKE_REASONING': '1'}, 'VISIBLE-ANSWER', 2)
check({'FAKE_MEDIA_EVENT': '1', 'FAKE_MEDIA_ALWAYS': '1'}, 'retained media history', 2, failed=True)
check({'FAKE_APPROVAL': '1'}, 'AUTO-APPROVED', 1, decisions=1)
check({'FAKE_APPROVAL': '1', 'FAKE_ALREADY_RESOLVED': '1'}, 'AUTO-APPROVED', 1, decisions=1)
check({'FAKE_APPROVAL': '1', 'FAKE_APPROVAL_DRIFT': '1'}, 'AUTO-APPROVED', 1, decisions=1)
# Sandboxed refresh spawns the sandboxed host itself (slow initialize); the turn
# reuses that same generation without respawn. The delayed SIGTERM close must
# still land cleanly at exit-time reap without poisoning anything.
check(
    {'FAKE_REASONING': '1', 'FAKE_DELAY_SIGTERM': '0.1', 'FAKE_DELAY_TRUST_INITIALIZE': '0.4'},
    'VISIBLE-ANSWER', 1, extra_args=('--muse-msp-sandboxed',),
)
check_compaction_context()
# Muse durably executes the command but the view projector drops the turn/start
# acknowledgement and every live event. The extension must enter log salvage,
# show the bounded reasoning summary, and recover the terminal answer.
check({'FAKE_DURABLE_NO_ACK': '1'}, 'DURABLE-ANSWER', 1)


def check_slow_durable_hold():
    # Slow turn with durable commits visible mid-turn while live deltas flow:
    # salvage must hold durable progress (not re-render the answer as
    # thinking). The hold is observable via the debug marker; -p hides
    # thinking blocks, so a duplicate would otherwise be invisible here.
    # Exactly 1 held item proves the assistant commit is excluded from
    # progress (reasoning summary only); 2 would mean the answer duplexed.
    with tempfile.TemporaryDirectory(prefix='msp-hold-') as tmp:
        log = Path(tmp) / 'calls'
        env = {k: v for k, v in os.environ.items() if not k.startswith('FAKE_')}
        env.update(HOME=tmp, PI_MUSE_BINARY=str(here / 'fake-host.py'), FAKE_MSP_LOG=str(log),
                   FAKE_SLOW_DURABLE='1', PI_MUSE_MSP_DEBUG='1')
        result = subprocess.run(['pi', '--no-session', '--no-extensions', '-e', str(extension),
            '--provider', 'muse-msp', '--model', 'muse-spark-1.3', '--no-tools',
            '-p', 'Test request'], env=env, text=True, capture_output=True, timeout=25)
        output = result.stdout + result.stderr
        assert result.returncode == 0, output
        assert 'SLOW-ANSWER' in output, output
        assert 'salvage progress held (1 item(s)' in output, output


check_slow_durable_hold()
check_user_input()
check_hang_start()
check_modellist_hang()
check_trust_args()
subprocess.run(['python3', str(here / 'vision-retry.py')], check=True, timeout=25)
subprocess.run(['python3', str(here / 'salvage-fresh.py')], check=True, timeout=25)
subprocess.run(['python3', str(here / 'steer.py')], check=True, timeout=30)
subprocess.run(['python3', str(here / 'turn-lifecycle.py')], check=True, timeout=120)
subprocess.run(['python3', str(here / 'model-switch.py')], check=True, timeout=60)
subprocess.run(['python3', str(here / 'subscribers.py')], check=True, timeout=90)
subprocess.run(['python3', str(here / 'subagents.py')], check=True, timeout=90)
subprocess.run(['python3', str(here / 'commands.py')], check=True, timeout=120)
subprocess.run(['python3', str(here / 'persistence-resume.py')], check=True, timeout=180)
# Machine-local suites: each skips cleanly (exit 0) when its non-repo
# dependency — an installed skill helper or companion extension — is absent.
for suite in ('proposals-inbox.py', 'session-context.py', 'memory-propose.py',
              'ask-approve-conformance.py'):
    subprocess.run(['python3', str(here / suite)], check=True, timeout=90)
print('PASS: version sync, event recovery, bounded repeated failure, duplicate/resolved approvals, image log recovery, compaction context, host generation isolation, pre-ack durable recovery, live-view progress hold, headless userInput cancel, hung-RPC bounds, vision retry, salvage-fresh, mid-turn steer, turn lifecycle, model switch, subscribers, subagent drill-down, workspace trust, persisted resume, machine-local suites')
