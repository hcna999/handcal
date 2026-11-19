#!/usr/bin/env python3
"""
핸드캘린더(HandCalendar) 빠른 추가 CLI
사용법:
  python handcal/scripts/handcal_cli.py add "내일 3시 치과 예약"
  python handcal/scripts/handcal_cli.py add --kind todo --date 2026-11-20 "우유 사기"
  python handcal/scripts/handcal_cli.py add --kind note "오늘 회의 요약"
  python handcal/scripts/handcal_cli.py summary [YYYY-MM-DD]
  python handcal/scripts/handcal_cli.py undo
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_WORKER_URL = "https://handcal.skgkrco2-6e6.workers.dev"


def load_env():
    """프로젝트 루트 또는 handcal 폴더의 .env에서 HANDCAL_INBOX_TOKEN 로드"""
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "..", "..", ".env"),
        os.path.join(here, "..", ".env"),
    ]
    for path in candidates:
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v


def api_call(method, path, payload=None):
    token = os.environ.get("HANDCAL_INBOX_TOKEN", "").strip()
    base = os.environ.get("HANDCAL_WORKER_URL", DEFAULT_WORKER_URL).rstrip("/")
    if not token:
        print(
            "[오류] HANDCAL_INBOX_TOKEN이 설정되지 않았습니다.\n"
            "핸드캘린더 앱 ⚙ → [빠른 추가]에서 연동 토큰을 발급한 뒤 루트 .env에 추가하세요:\n"
            "  HANDCAL_INBOX_TOKEN=발급받은토큰",
            file=sys.stderr,
        )
        sys.exit(2)

    url = f"{base}{path}"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "X-Inbox-Token": token,
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "handcal-cli/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            err = json.loads(raw)
            msg = err.get("message") or err.get("error") or raw
        except Exception:
            msg = raw
        print(f"[HTTP {e.code}] {msg}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"[연결 오류] {e}", file=sys.stderr)
        sys.exit(1)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    load_env()

    parser = argparse.ArgumentParser(description="핸드캘린더 빠른 추가 CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_add = sub.add_parser("add", help="일정·할 일·메모 추가")
    p_add.add_argument("text", help="추가할 내용 (자연어 가능)")
    p_add.add_argument("--kind", choices=["event", "todo", "note"], help="종류 강제 지정")
    p_add.add_argument("--date", help="날짜 강제 지정 (YYYY-MM-DD)")
    p_add.add_argument("--start", help="시작 시간 (HH:MM)")
    p_add.add_argument("--end", help="종료 시간 (HH:MM)")

    p_sum = sub.add_parser("summary", help="특정 날짜 일정·할 일·메모 조회")
    p_sum.add_argument("date", nargs="?", default="", help="YYYY-MM-DD (생략 시 오늘)")

    sub.add_parser("undo", help="직전에 추가한 항목 되돌리기")

    args = parser.parse_args()

    if args.cmd == "add":
        payload = {"text": args.text}
        if args.kind:
            payload["kind"] = args.kind
            payload["title"] = args.text
        if args.date:
            payload["date"] = args.date
        if args.start:
            payload["startTime"] = args.start
            payload["allDay"] = False
        if args.end:
            payload["endTime"] = args.end
        res = api_call("POST", "/inbox/add", payload)
        print(json.dumps(res, ensure_ascii=False, indent=2))

    elif args.cmd == "summary":
        q = f"?date={urllib.parse.quote(args.date)}" if args.date else ""
        res = api_call("GET", f"/inbox/summary{q}")
        print(json.dumps(res, ensure_ascii=False, indent=2))

    elif args.cmd == "undo":
        res = api_call("POST", "/inbox/undo", {})
        print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
