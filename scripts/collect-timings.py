#!/usr/bin/env python3
"""Join GitHub job timestamps with one raw runner-spawn measurement."""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any


DEFAULT_REPOSITORY = os.environ.get("GITHUB_REPOSITORY", "")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Print job timing rows for one GitHub Actions run.",
    )
    parser.add_argument("run_id", type=int, help="The GitHub Actions run ID.")
    parser.add_argument(
        "--repository",
        default=os.environ.get("GITHUB_REPOSITORY", DEFAULT_REPOSITORY),
        help="The OWNER/REPO repository name.",
    )
    parser.add_argument(
        "--raw",
        type=Path,
        help="The raw JSON path. The default is results/raw/RUN_ID.json.",
    )
    return parser.parse_args()


def gh_jobs(repository: str, run_id: int) -> list[dict[str, Any]]:
    endpoint = f"repos/{repository}/actions/runs/{run_id}/jobs?per_page=100"
    try:
        result = subprocess.run(
            [
                "gh",
                "api",
                "--paginate",
                "--slurp",
                "--header",
                "X-GitHub-Api-Version: 2026-03-10",
                endpoint,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise SystemExit("gh must be installed") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() or f"gh exited with status {error.returncode}"
        raise SystemExit(f"Failed to read GitHub jobs: {detail}") from error

    pages = json.loads(result.stdout)
    return [job for page in pages for job in page.get("jobs", [])]


def load_spawns(path: Path) -> list[dict[str, Any]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise SystemExit(f"Raw measurement file does not exist: {path}") from error
    except json.JSONDecodeError as error:
        raise SystemExit(f"Raw measurement file is invalid JSON: {path}: {error}") from error

    spawns = raw.get("spawnAttempts")
    if not isinstance(spawns, list):
        raise SystemExit(f"Raw measurement file has no spawnAttempts list: {path}")
    return spawns


def parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def elapsed_seconds(start: str | None, end: str | None) -> str:
    start_time = parse_timestamp(start)
    end_time = parse_timestamp(end)
    if start_time is None or end_time is None:
        return "TBD"
    return f"{(end_time - start_time).total_seconds():.3f}"


def markdown_cell(value: Any) -> str:
    if value is None or value == "":
        return "TBD"
    return str(value).replace("|", "\\|").replace("\n", " ")


def spawn_indexes(
    spawns: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    by_runner: dict[str, dict[str, Any]] = {}
    for spawn in spawns:
        response = spawn.get("response") or {}
        runner_name = response.get("runnerName")
        if isinstance(runner_name, str) and runner_name:
            by_runner[runner_name] = spawn
    return by_runner


def timing_cells(
    run_id: int,
    job_name: Any,
    runner_name: str,
    job: dict[str, Any],
    spawn: dict[str, Any] | None,
) -> list[Any]:
    response = (spawn or {}).get("response") or {}
    timings = response.get("timings") or {}
    return [
        run_id,
        job_name,
        runner_name,
        timings.get("registrationTokenMs"),
        timings.get("sandboxStartProcessMs"),
        timings.get("runnerOnlineMs"),
        timings.get("totalMs"),
        elapsed_seconds(job.get("created_at"), job.get("started_at")),
        elapsed_seconds(job.get("started_at"), job.get("completed_at")),
        elapsed_seconds(job.get("created_at"), job.get("completed_at")),
    ]


def main() -> int:
    arguments = parse_arguments()
    raw_path = arguments.raw or Path("results/raw") / f"{arguments.run_id}.json"
    jobs = gh_jobs(arguments.repository, arguments.run_id)
    spawns = load_spawns(raw_path)
    by_runner = spawn_indexes(spawns)

    headings = [
        "Run",
        "Job",
        "Runner",
        "Registration token (ms)",
        "Sandbox startProcess (ms)",
        "Runner online (ms)",
        "Spawn total (ms)",
        "Queued to started (s)",
        "Run duration (s)",
        "Job total (s)",
    ]
    print("| " + " | ".join(headings) + " |")
    print("| " + " | ".join("---" for _ in headings) + " |")

    for job in jobs:
        runner_name = job.get("runner_name") or ""
        spawn = by_runner.get(runner_name)
        cells = timing_cells(
            arguments.run_id,
            job.get("name"),
            runner_name,
            job,
            spawn,
        )
        print("| " + " | ".join(markdown_cell(cell) for cell in cells) + " |")

    job_runner_names = {
        job.get("runner_name") for job in jobs if job.get("runner_name")
    }
    for spawn in spawns:
        response = spawn.get("response") or {}
        runner_name = response.get("runnerName") or ""
        if runner_name in job_runner_names:
            continue
        cells = timing_cells(
            arguments.run_id,
            "Unattributed spawn",
            runner_name,
            {},
            spawn,
        )
        print("| " + " | ".join(markdown_cell(cell) for cell in cells) + " |")

    return 0


if __name__ == "__main__":
    sys.exit(main())
