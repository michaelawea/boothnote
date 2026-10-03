#!/usr/bin/env python3
"""Local deterministic Twenty HTTP fixture; never a substitute for real Twenty.

Run: python3 services/gateway/src/__tests__/fixtures/boothnote_fake_twenty.py --port 0
POST /__fixture/reset {"tables": {"companies": [{...}]}} seeds isolated data.
POST /__fixture/fail {"method":"PATCH", "path":"/rest/supportCases/ID",
  "status":503, "times":1, "delayMs":0} injects deterministic transport failure.
Set dropAfterWrite:true to apply a write and lose its response. Set after:1 to
allow one matching request before injecting the failure. Neither mode establishes
real Twenty idempotency/schema behavior; unknown write outcomes must stay unknown.
GET /__fixture/state returns tables/audit. Audit omits authentication headers.
Unknown routes and unsupported filters fail loudly; no outbound networking.
"""

import argparse
import copy
import json
import re
import socket
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

SINGULAR = {
    "companies": "company", "contributors": "contributor", "suppliers": "supplier",
    "products": "product", "projects": "project", "workItems": "workItem",
    "projectDocs": "projectDoc", "productFitments": "productFitment",
    "supportCases": "supportCase", "visits": "visit", "intelValues": "intelValue",
    "opportunities": "opportunity", "timelineActivities": "timelineActivity",
    "projectTypes": "projectType", "projectTypeStages": "projectTypeStage",
    "projectUpdates": "projectUpdate", "consumerSurveys": "consumerSurvey",
}
RELATIONS = {
    "company": "companies", "contributor": "contributors", "recordedBy": "contributors",
    "project": "projects", "workItem": "workItems", "supplier": "suppliers",
    "soldVia": "companies", "parentCompany": "companies", "projectType": "projectTypes",
    "currentStage": "projectTypeStages",
}
LOCK = threading.RLock()
TABLES = {key: {} for key in SINGULAR}
AUDIT = []
FAILURES = []


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def hydrate(record, depth):
    result = copy.deepcopy(record)
    if depth:
        for relation, collection in RELATIONS.items():
            identity = result.get(relation + "Id")
            if identity is not None:
                result[relation] = copy.deepcopy(TABLES[collection].get(identity))
    return result


def apply_filter(records, expression):
    if not expression:
        return records
    # Accept only complete eq/neq/ilike clauses joined by commas. This deliberately
    # does not attempt to replicate Twenty's complete filter language.
    clauses = []
    remaining = expression
    pattern = re.compile(r'([A-Za-z][\w]*)\[(eq|neq|ilike)\]:("[^"]*"|[^,]+)(?:,|$)')
    while remaining:
        clause = pattern.match(remaining)
        if not clause:
            raise ValueError("Unsupported fixture filter: " + expression)
        clauses.append(clause.groups())
        remaining = remaining[clause.end():]
    for field, operation, raw in clauses:
        value = raw.strip().strip('"')
        def match(record):
            actual = record.get(field)
            if operation == "eq":
                return str(actual).lower() == value.lower()
            if operation == "neq":
                return str(actual).lower() != value.lower()
            pattern = re.escape(value).replace("%", ".*").replace("_", ".")
            return re.fullmatch(pattern, str(actual or ""), re.I) is not None
        records = [record for record in records if match(record)]
    return records


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def body(self):
        count = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(count)) if count else {}

    def respond(self, status, payload):
        if hasattr(self, "audit_event"):
            with LOCK:
                self.audit_event.setdefault("status", status)
        if getattr(self, "drop_after_write", False):
            self.drop_after_write = False
            with LOCK:
                self.audit_event["responseDropped"] = True
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        encoded = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self): self.handle_request()
    def do_POST(self): self.handle_request()
    def do_PATCH(self): self.handle_request()
    def do_DELETE(self): self.handle_request()

    def handle_request(self):
        if hasattr(self, "audit_event"):
            del self.audit_event
        url = urlparse(self.path)
        path = unquote(url.path)
        query = parse_qs(url.query)
        method = self.command
        try:
            body = self.body()
            if not isinstance(body, dict):
                return self.respond(400, {"error": "Request body must be an object"})
        except Exception as error:
            return self.respond(400, {"error": str(error)})

        if path == "/__fixture/reset" and method == "POST":
            with LOCK:
                seed = body.get("tables", {})
                if not isinstance(seed, dict) or any(name not in TABLES or not isinstance(rows, list) for name, rows in seed.items()):
                    return self.respond(400, {"error": "Invalid fixture seed"})
                if any(not isinstance(row, dict) or not isinstance(row.get("id", ""), str) for rows in seed.values() for row in rows):
                    return self.respond(400, {"error": "Invalid fixture record"})
                for name in TABLES:
                    TABLES[name].clear()
                for name, rows in seed.items():
                    for row in rows:
                        record = {"createdAt": now(), "updatedAt": now(), **row}
                        record.setdefault("id", str(uuid.uuid4()))
                        TABLES[name][record["id"]] = record
                AUDIT.clear()
                FAILURES.clear()
            return self.respond(200, {"ok": True, "fixture": True})
        if path == "/__fixture/fail" and method == "POST":
            if body.get("method") not in ["GET", "POST", "PATCH", "DELETE"] or not str(body.get("path", "")).startswith("/rest/"):
                return self.respond(400, {"error": "Invalid failure method/path"})
            if body.get("dropAfterWrite") and body["method"] not in ["POST", "PATCH", "DELETE"]:
                return self.respond(400, {"error": "dropAfterWrite requires a write"})
            for name in ["times", "after", "delayMs"]:
                if name in body and (not isinstance(body[name], int) or body[name] < 0):
                    return self.respond(400, {"error": "Invalid failure counter"})
            if not body.get("dropAfterWrite") and (not isinstance(body.get("status", 503), int) or not 400 <= body.get("status", 503) <= 599):
                return self.respond(400, {"error": "Failure status must be 4xx/5xx"})
            with LOCK:
                FAILURES.append({"method": "POST", "status": 503, "times": 1, **body})
            return self.respond(200, {"ok": True, "fixture": True})
        if path == "/__fixture/state" and method == "GET":
            with LOCK:
                snapshot = copy.deepcopy({"fixture": True, "tables": TABLES, "audit": AUDIT})
            return self.respond(200, snapshot)
        if path == "/healthz":
            return self.respond(200, {"status": "fixture", "realTwenty": False})

        failure = None
        with LOCK:
            event = {"index": len(AUDIT), "method": method, "path": path, "query": query, "body": body}
            self.audit_event = event
            AUDIT.append(event)
            for candidate in FAILURES:
                if candidate.get("times", 0) and candidate["method"] == method and candidate.get("path") == path:
                    if candidate.get("after", 0):
                        candidate["after"] -= 1
                        continue
                    candidate["times"] -= 1
                    failure = copy.deepcopy(candidate)
                    break
        if failure:
            time.sleep(failure.get("delayMs", 0) / 1000)
            if failure.get("status", 0) and not failure.get("dropAfterWrite"):
                event["status"] = failure["status"]
                return self.respond(failure["status"], {"error": "Injected fixture failure", "fixture": True})

        if path == "/rest/metadata/objects" and method == "GET":
            objects = [{"id": str(uuid.uuid5(uuid.NAMESPACE_URL, name)), "nameSingular": name, "namePlural": plural, "fields": []}
                       for plural, name in SINGULAR.items()]
            return self.respond(200, {"data": {"objects": objects}, "pageInfo": {"hasNextPage": False}})

        match = re.fullmatch(r"/rest/([A-Za-z]+)(?:/([\w-]+))?", path)
        if not match or match[1] not in TABLES:
            event["status"] = 404
            return self.respond(404, {"error": "Unsupported fixture route: " + method + " " + path})
        collection, identity = match.groups()
        singular = SINGULAR[collection]
        cap = singular[0].upper() + singular[1:]
        with LOCK:
            table = TABLES[collection]
            if method == "GET" and not identity:
                records = [record for record in table.values() if not record.get("deletedAt")]
                try:
                    records = apply_filter(records, query.get("filter", [""])[0])
                except ValueError as error:
                    return self.respond(400, {"error": str(error)})
                ordering = query.get("order_by", [""])[0]
                if ordering:
                    field = ordering.split("[")[0]
                    records.sort(key=lambda record: str(record.get(field) or ""), reverse="Desc" in ordering)
                cursor = query.get("starting_after", [""])[0]
                if cursor:
                    found = next((index for index, record in enumerate(records) if record["id"] == cursor), -1)
                    records = records[found + 1:]
                limit = int(query.get("limit", ["200"])[0])
                has_next = len(records) > limit
                records = records[:limit]
                depth = int(query.get("depth", ["0"])[0])
                event["status"] = 200
                return self.respond(200, {"data": {collection: [hydrate(record, depth) for record in records]},
                                         "pageInfo": {"hasNextPage": has_next, "endCursor": records[-1]["id"] if records else None}})
            if method == "GET" and identity in table:
                event["status"] = 200
                return self.respond(200, {"data": {singular: hydrate(table[identity], 1)}})
            if method == "POST" and not identity:
                if collection == "supportCases" and not isinstance(body.get("issueDescription"), dict):
                    event["status"] = 400
                    return self.respond(400, {"error": "issueDescription must be rich text"})
                record = {"createdAt": now(), "updatedAt": now(), **body, "id": body.get("id") or str(uuid.uuid4())}
                if record["id"] in table:
                    return self.respond(409, {"error": "Fixture ID already exists"})
                table[record["id"]] = record
                event["status"] = 201
                event["resultId"] = record["id"]
                event["applied"] = True
                self.drop_after_write = bool(failure and failure.get("dropAfterWrite"))
                return self.respond(201, {"data": {"create" + cap: copy.deepcopy(record)}})
            if method == "PATCH" and identity in table:
                table[identity].update(body)
                table[identity]["updatedAt"] = now()
                event["status"] = 200
                event["resultId"] = identity
                event["applied"] = True
                self.drop_after_write = bool(failure and failure.get("dropAfterWrite"))
                return self.respond(200, {"data": {"update" + cap: copy.deepcopy(table[identity])}})
            if method == "DELETE" and identity in table:
                deleted = table.pop(identity)
                event["status"] = 200
                event["applied"] = True
                self.drop_after_write = bool(failure and failure.get("dropAfterWrite"))
                return self.respond(200, {"data": {"delete" + cap: deleted}})
        event["status"] = 404
        return self.respond(404, {"error": "Fixture record not found"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--address-file")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    address = "http://127.0.0.1:" + str(server.server_address[1])
    if args.address_file:
        Path(args.address_file).write_text(address)
    print(json.dumps({"fixture": True, "realTwenty": False, "url": address}), flush=True)
    server.serve_forever()
