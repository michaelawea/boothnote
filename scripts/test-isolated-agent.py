#!/usr/bin/env python3
"""Isolated real gateway/Postgres + deterministic FAKE Twenty test stack.

No production services are contacted. This is contract/E2E testing, not Twenty
product validation. A command receives safe local fixture environment variables.
Example: python3 scripts/test-isolated-agent.py
Custom: python3 scripts/test-isolated-agent.py -- node --test PATH
The default suite gives each test file its own complete stack: resetting the fake
CRM must not retain a previous file's gateway/customer cache or database rows.
Each run migrates a new database. --hold keeps the supervisor alive for manual
fixture/browser checks until SIGINT/SIGTERM. Connection selectors contain only
fixture placeholders and are written into the run's unique /tmp log directory.
"""
import argparse
import json
import os
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


class StartupFailed(RuntimeError):
    pass


POSTGRES_READY_PROBE = r"""
import postgres from 'postgres';
const sql = postgres(process.env.APP_DATABASE_URL, { max: 1, connect_timeout: 1, idle_timeout: 1 });
const deadline = Date.now() + Number(process.argv[1]);
let ready = false;
let lastError = 'not connected';
let progressAt = 0;
try {
  while (Date.now() < deadline) {
    try {
      const [row] = await sql.unsafe('select current_database() as database, 1 as ready');
      if (row?.database !== 'boothnote' || row.ready !== 1) throw new Error('Unexpected fixture database');
      ready = true;
      console.log('Published fixture PostgreSQL ready: boothnote');
      break;
    } catch (error) {
      lastError = error.code ?? error.message;
      if (Date.now() >= progressAt) {
        console.error('Waiting for published fixture PostgreSQL: ' + lastError);
        progressAt = Date.now() + 3000;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) {
    console.error('Published fixture PostgreSQL not ready: ' + lastError);
    process.exitCode = 1;
  }
} finally {
  await sql.end({ timeout: 1 });
}
"""


def wait_for_postgres(root, env, log, seconds=45):
    """Probe the authenticated published TCP/database used by migrations.

    postgres's image initially runs a temporary Unix-socket-only server.
    Container-local pg_isready can succeed before boothnote or the final TCP server
    exists. Never retry migrations to compensate for an incomplete startup.
    """
    try:
        result = subprocess.run(["node", "--input-type=module", "--eval", POSTGRES_READY_PROBE, str(seconds * 1000)],
                                cwd=root / "services/gateway", env=env, stdout=log, stderr=subprocess.STDOUT,
                                timeout=seconds)
    except subprocess.TimeoutExpired as error:
        raise StartupFailed(f"Published fixture PostgreSQL did not become ready within {seconds}s; inspect {log.name}") from error
    if result.returncode:
        raise StartupFailed(f"Published fixture PostgreSQL is not ready; inspect {log.name}")


def ensure_postgres_image(docker, env):
    """Give a cold image download its own bound, before creating any container."""
    cached = subprocess.run(docker + ["image", "inspect", "postgres:16"], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    if cached.returncode:
        print(json.dumps({"pullingFixtureImage": "postgres:16", "timeoutSeconds": 120}), flush=True)
        subprocess.run(docker + ["pull", "postgres:16"], env=env, check=True, timeout=120)


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def until(call, seconds=45):
    started = time.monotonic()
    last = None
    while time.monotonic() - started < seconds:
        try:
            return call()
        except StartupFailed:
            raise
        except Exception as error:
            last = error
            time.sleep(0.25)
    raise RuntimeError("Local fixture did not become ready: " + str(last))


def default_suite(root, state_file):
    files = ["agent-flows.e2e.test.ts", "item-recovery.e2e.test.ts", "agent-disposition.e2e.test.ts"]
    active = None
    failures = []
    previous_handlers = {}
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()
    for sig in [signal.SIGINT, signal.SIGTERM]:
        previous_handlers[sig] = signal.signal(sig, interrupted)
    try:
        print(json.dumps({"readinessRegression": True, "realTwenty": False}), flush=True)
        active = subprocess.Popen([sys.executable, str(root / "scripts/test-isolated-agent-readiness.py"), "--repo", str(root)],
                                  start_new_session=True)
        code = active.wait()
        if code:
            return code
        for name in files:
            command = [sys.executable, str(Path(__file__).resolve()), "--repo", str(root)]
            if state_file:
                command += ["--state-file", state_file]
            command += ["--", "node", "--test", "services/gateway/src/__tests__/" + name]
            print(json.dumps({"suite": name, "freshStack": True, "realTwenty": False}), flush=True)
            active = subprocess.Popen(command, start_new_session=True)
            code = active.wait()
            if code:
                failures.append({"suite": name, "exitCode": code})
        print(json.dumps({"isolatedSuites": len(files), "failures": failures}), flush=True)
        return 1 if failures else 0
    except KeyboardInterrupt:
        return 130
    finally:
        if active and active.poll() is None:
            try:
                os.killpg(active.pid, signal.SIGTERM)
                active.wait(timeout=30)
            except ProcessLookupError:
                pass
            except subprocess.TimeoutExpired:
                os.killpg(active.pid, signal.SIGKILL)
                active.wait(timeout=5)
        for sig, previous in previous_handlers.items():
            signal.signal(sig, previous)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument("--state-file")
    parser.add_argument("--hold", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    root = Path(args.repo)
    if not (root / "services/gateway/src/index.ts").exists():
        raise RuntimeError("Not an Boothnote Map gateway repository")
    if not command and not args.hold:
        return default_suite(root, args.state_file)
    run_dir = Path(tempfile.mkdtemp(prefix="boothnote-fixture-stack-", dir="/tmp"))
    state_file = Path(args.state_file) if args.state_file else run_dir / "state.json"
    cid = "boothnote-fixture-" + str(os.getpid()) + "-" + run_dir.name[-8:]
    pg_port, gw_port, twenty_port = free_port(), free_port(), free_port()
    env = os.environ.copy()
    env.update({
        "APP_DATABASE_URL": f"postgres://postgres:itest@127.0.0.1:{pg_port}/boothnote",
        "GATEWAY_PORT": str(gw_port), "GATEWAY_URL": f"http://127.0.0.1:{gw_port}",
        "SERVER_URL": f"http://127.0.0.1:{twenty_port}", "TWENTY_API_KEY": "local-fixture-only",
        "GATEWAY_JWT_SECRET": "local-fixture-only", "OPENAI_API_KEY": "local-fixture-only",
        "OPENAI_BASE_URL": "http://127.0.0.1:9/v1", "AGENT_ENABLED": "0", "AGENT_MULTI_ITEMS": "1",
        "TRANSCRIBE_SELFTEST": "0", "GATEWAY_AUDIO_DIR": str(run_dir / "audio"),
        "ADMIN_TOKEN": "local-fixture-only", "CHANNEL_DINGTALK_SECRET": "local-fixture-only",
        "CHANNEL_LAB_SECRET": "local-fixture-only", "PORTAL_SECRET": "local-fixture-only",
        "CHANNEL_AUTOCOMMIT_SECONDS": "0", "CONFIRM_DELAY_MS": "1000",
        "DINGTALK_DEFAULT_WEBHOOK": "", "ALLOW_NONLOCAL_TESTS": "",
        "CAPTURE_URL": f"http://127.0.0.1:{gw_port}", "FIXTURE_TWENTY_URL": f"http://127.0.0.1:{twenty_port}",
    })
    docker_env = env.copy()
    for name in ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]:
        docker_env.pop(name, None)
    docker = ["docker", "--host=unix:///var/run/docker.sock"]
    children = []
    handles = []
    created_container = False
    def cleanup():
        for child in reversed(children):
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
        for child in reversed(children):
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
        if created_container:
            try:
                with (run_dir / "postgres.log").open("w") as postgres_log:
                    subprocess.run(docker + ["logs", cid], env=docker_env, stdout=postgres_log,
                                   stderr=subprocess.STDOUT, timeout=15)
            finally:
                subprocess.run(docker + ["rm", "-fv", cid], env=docker_env, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=15)
        for handle in handles:
            handle.close()
        shutil.rmtree(run_dir / "audio", ignore_errors=True)
        state_file.unlink(missing_ok=True)
    def interrupted(signum, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        subprocess.run(docker + ["info", "--format", "{{.ServerVersion}}"], env=docker_env, check=True, stdout=subprocess.DEVNULL)
        ensure_postgres_image(docker, docker_env)
        # The unique name belongs to this run even if interruption happens after
        # Docker creates it but before the client command returns.
        created_container = True
        subprocess.run(docker + ["run", "-d", "--name", cid, "-e", "POSTGRES_PASSWORD=itest", "-e", "POSTGRES_DB=boothnote",
                               "-p", f"127.0.0.1:{pg_port}:5432", "postgres:16"], env=docker_env, check=True, stdout=subprocess.DEVNULL)
        readiness_log = (run_dir / "readiness.log").open("w")
        handles.append(readiness_log)
        print(json.dumps({"waitingFor": "published_fixture_database", "timeoutSeconds": 45,
                          "logs": str(run_dir)}), flush=True)
        try:
            wait_for_postgres(root, env, readiness_log)
        except StartupFailed:
            readiness_log.flush()
            print("Fixture database readiness failed; final 20 log lines:", flush=True)
            print("\n".join((run_dir / "readiness.log").read_text(errors="replace").splitlines()[-20:]), flush=True)
            raise
        fixture_log = (run_dir / "twenty.log").open("w")
        handles.append(fixture_log)
        fixture = subprocess.Popen([sys.executable, str(root / "services/gateway/src/__tests__/fixtures/boothnote_fake_twenty.py"), "--port", str(twenty_port)], env=env,
                                   stdout=fixture_log, stderr=subprocess.STDOUT, start_new_session=True)
        children.append(fixture)
        until(lambda: urllib.request.urlopen(env["SERVER_URL"] + "/healthz", timeout=1).close())
        migration_log = (run_dir / "migration.log").open("w")
        handles.append(migration_log)
        try:
            subprocess.run(["node", "src/migrate.ts"], cwd=root / "services/gateway", env=env,
                           stdout=migration_log, stderr=subprocess.STDOUT, check=True)
        except subprocess.CalledProcessError:
            migration_log.flush()
            print("Fixture migration failed; final 40 log lines:", flush=True)
            print("\n".join((run_dir / "migration.log").read_text(errors="replace").splitlines()[-40:]), flush=True)
            raise
        gateway_log = (run_dir / "gateway.log").open("w")
        handles.append(gateway_log)
        gateway = subprocess.Popen(["node", "src/index.ts"], cwd=root / "services/gateway", env=env,
                                   stdout=gateway_log, stderr=subprocess.STDOUT, start_new_session=True)
        children.append(gateway)
        def gateway_ready():
            if gateway.poll() is not None:
                raise StartupFailed("Gateway exited; inspect " + str(run_dir / "gateway.log"))
            urllib.request.urlopen(env["GATEWAY_URL"] + "/health", timeout=1).close()
        until(gateway_ready)
        selectors = {name: env[name] for name in ["APP_DATABASE_URL", "GATEWAY_URL", "GATEWAY_PORT", "SERVER_URL", "FIXTURE_TWENTY_URL",
                                                "TWENTY_API_KEY", "GATEWAY_JWT_SECRET", "OPENAI_API_KEY", "OPENAI_BASE_URL", "GATEWAY_AUDIO_DIR",
                                                "AGENT_ENABLED", "AGENT_MULTI_ITEMS", "ADMIN_TOKEN", "PORTAL_SECRET", "CONFIRM_DELAY_MS"]}
        state_file.write_text(json.dumps({"fixture": True, "realTwenty": False, "container": cid,
                                                   "logs": str(run_dir), "env": selectors}, indent=2))
        print(json.dumps({"ready": True, "fixture": True, "realTwenty": False, "stateFile": str(state_file),
                          "logs": str(run_dir), "gateway": env["GATEWAY_URL"], "twenty": env["SERVER_URL"]}), flush=True)
        if command:
            test = subprocess.Popen(command, cwd=root, env=env, start_new_session=True)
            children.append(test)
            return test.wait()
        while gateway.poll() is None and fixture.poll() is None:
            time.sleep(0.5)
        raise RuntimeError("Isolated service exited unexpectedly")
    except KeyboardInterrupt:
        return 130
    finally:
        cleanup()
        print(json.dumps({"cleanedUp": True, "container": cid, "logsRetained": str(run_dir)}), flush=True)


if __name__ == "__main__":
    sys.exit(main())
