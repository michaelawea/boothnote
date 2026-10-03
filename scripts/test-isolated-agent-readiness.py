#!/usr/bin/env python3
"""Deterministic real PostgreSQL regression for the isolated runner's readiness.

The init script holds PostgreSQL's temporary Unix server until the test releases
it. There is no production database, CRM or model connection and no migration
retry. Every container is removed; fixture-only startup logs remain in /tmp.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("isolated_agent", ROOT / "scripts/test-isolated-agent.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class PublishedDatabaseReadiness(unittest.TestCase):
    def test_temporary_socket_is_insufficient_and_published_sql_must_authenticate_to_boothnote(self):
        run_dir = Path(tempfile.mkdtemp(prefix="boothnote-fixture-stack-readiness-", dir="/tmp"))
        cid = "boothnote-fixture-readiness-" + str(os.getpid()) + "-" + run_dir.name[-8:]
        port = runner.free_port()
        env = os.environ.copy()
        for name in ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]:
            env.pop(name, None)
        env["APP_DATABASE_URL"] = f"postgres://postgres:itest@127.0.0.1:{port}/boothnote"
        docker = ["docker", "--host=unix:///var/run/docker.sock"]
        created = False

        def command(args, check=True):
            return subprocess.run(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  text=True, check=check, timeout=15)

        # Unlike a timed sleep, this barrier cannot finish before the negative
        # check runs on a busy CI host. Its own limit avoids an orphaned startup.
        init = run_dir / "010-readiness-barrier.sh"
        init.write_text("#!/bin/sh\nset -eu\ncount=0\n"
                        "while [ ! -e /tmp/boothnote-fixture-init-release ]; do\n"
                        "  count=$((count + 1))\n"
                        "  if [ \"$count\" -ge 600 ]; then echo 'Fixture init release timed out' >&2; exit 1; fi\n"
                        "  sleep 0.1\ndone\n")
        init.chmod(0o755)
        try:
            runner.ensure_postgres_image(docker, env)
            created = True  # Also clean up an interrupted Docker create command.
            command(docker + ["create", "--name", cid, "-e", "POSTGRES_PASSWORD=itest", "-e", "POSTGRES_DB=boothnote",
                              "-p", f"127.0.0.1:{port}:5432", "postgres:16"])
            command(docker + ["cp", str(init), cid + ":/docker-entrypoint-initdb.d/010-readiness-barrier.sh"])
            command(docker + ["start", cid])

            def temporary_ready():
                result = command(docker + ["exec", cid, "pg_isready", "-q"], check=False)
                if result.returncode:
                    raise RuntimeError("Temporary Unix PostgreSQL starting")
            runner.until(temporary_ready)
            self.assertNotEqual(command(docker + ["exec", cid, "pg_isready", "-q", "-h", "127.0.0.1",
                                                  "-p", "5432", "-U", "postgres", "-d", "boothnote"], check=False).returncode, 0)
            with (run_dir / "temporary-readiness.log").open("w") as log:
                with self.assertRaises(runner.StartupFailed):
                    runner.wait_for_postgres(ROOT, env, log, seconds=1.5)

            command(docker + ["exec", cid, "touch", "/tmp/boothnote-fixture-init-release"])
            with (run_dir / "ready.log").open("w") as log:
                runner.wait_for_postgres(ROOT, env, log)
            self.assertIn("Published fixture PostgreSQL ready: boothnote", (run_dir / "ready.log").read_text())

            for name, url in [
                ("wrong-database", f"postgres://postgres:itest@127.0.0.1:{port}/postgres"),
                ("wrong-password", f"postgres://postgres:incorrect-fixture-password@127.0.0.1:{port}/boothnote"),
            ]:
                invalid = {**env, "APP_DATABASE_URL": url}
                with (run_dir / (name + ".log")).open("w") as log:
                    with self.assertRaises(runner.StartupFailed):
                        runner.wait_for_postgres(ROOT, invalid, log, seconds=1.5)
        finally:
            if created:
                try:
                    with (run_dir / "postgres.log").open("w") as log:
                        subprocess.run(docker + ["logs", cid], env=env, stdout=log, stderr=subprocess.STDOUT, timeout=15)
                finally:
                    command(docker + ["rm", "-fv", cid], check=False)
            print(json.dumps({"readinessRegressionCleanedUp": True, "container": cid,
                              "logsRetained": str(run_dir)}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=ROOT)
    args, unittest_args = parser.parse_known_args()
    ROOT = args.repo
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()
    for sig in [signal.SIGINT, signal.SIGTERM]:
        signal.signal(sig, interrupted)
    try:
        unittest.main(argv=[__file__, *unittest_args], verbosity=2)
    except KeyboardInterrupt:
        sys.exit(130)
