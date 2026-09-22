import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/context/store.js";
import { queryContext } from "../src/context/retriever.js";

function insertFile(db, filePath, language = "typescript") {
  db.prepare(
    "INSERT INTO files(path,language,content_hash,line_count,parser_version,indexed_at,is_test,package_name) VALUES(?,?,?,?,?,?,?,?)"
  ).run(filePath, language, "hash-" + filePath, 10, "0.2.5", "2026-01-01T00:00:00Z", 0, language === "go" ? "fixture" : null);
}

function insertSymbol(db, {
  id, file, language, name, qualified = name, kind = "function", receiver = null
}) {
  db.prepare(`INSERT INTO symbols(
    symbol_id,file_path,language,name,qualified_name,kind,receiver,signature,
    params_json,returns_json,description,description_source,line_start,line_end,
    implementation_hash,semantic_hash
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, file, language, name, qualified, kind, receiver, name + "()",
    "[]", "[]", name + " in " + file, "derived", 1, 3, "impl-" + id, "sem-" + id
  );
}

function insertEdge(db, {
  id, from, to, type, sourceId
}) {
  db.prepare(`INSERT INTO edges(
    edge_id,from_node_id,to_node_id,type,confidence,evidence_json,source_kind,source_id
  ) VALUES(?,?,?,?,?,?,?,?)`).run(
    id, from, to, type, "static",
    JSON.stringify({ type: "static_resolution", source: "fixture", source_id: sourceId }),
    "fixture", sourceId
  );
}

test("query crosses shared data flow into a differently named client surface", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cce-cross-surface-"));
  try {
    await fs.writeFile(
      path.join(root, ".context-query-aliases.json"),
      JSON.stringify({ "人工任务": ["manualtask", "manual_task"] }, null, 2)
    );

    const { db } = openStore(path.join(root, ".context-index"));
    try {
      const adminFile = "admin-web/src/api/manualtask.ts";
      const repoFile = "backend/assignment/repository.go";
      const serviceFile = "backend/assignment/service.go";
      const handlerFile = "backend/http/assignments.go";
      const clientFile = "miniprogram/services/student-assignments.ts";
      const pageFile = "miniprogram/pages/student/index.ts";

      insertFile(db, adminFile);
      insertFile(db, repoFile, "go");
      insertFile(db, serviceFile, "go");
      insertFile(db, handlerFile, "go");
      insertFile(db, clientFile);
      insertFile(db, pageFile);

      const adminSymbol = "typescript:admin-web/src/api/manualtask.ts::listManualTasks";
      const repoSymbol = "go:backend/assignment/repository.go::*Repository.List";
      const serviceSymbol = "go:backend/assignment/service.go::*Service.List";
      const handlerSymbol = "go:backend/http/assignments.go::*API.List";
      const clientSymbol = "typescript:miniprogram/services/student-assignments.ts::getAssignments";

      insertSymbol(db, {
        id: adminSymbol, file: adminFile, language: "typescript",
        name: "listManualTasks"
      });
      insertSymbol(db, {
        id: repoSymbol, file: repoFile, language: "go",
        name: "List", qualified: "*Repository.List", kind: "method", receiver: "*Repository"
      });
      insertSymbol(db, {
        id: serviceSymbol, file: serviceFile, language: "go",
        name: "List", qualified: "*Service.List", kind: "method", receiver: "*Service"
      });
      insertSymbol(db, {
        id: handlerSymbol, file: handlerFile, language: "go",
        name: "List", qualified: "*API.List", kind: "method", receiver: "*API"
      });
      insertSymbol(db, {
        id: clientSymbol, file: clientFile, language: "typescript",
        name: "getAssignments"
      });

      db.prepare(`INSERT INTO db_objects(
        file_path,symbol_id,object_type,object_name,operation,line
      ) VALUES(?,?,?,?,?,?)`).run(
        repoFile, repoSymbol, "table", "public.manual_task_publications", "select", 4
      );

      const routePath = "/api/v2/parent/students/{student_id}/assignments";
      db.prepare(`INSERT INTO routes(
        file_path,symbol_id,method,route_path,direction,line,handler_ref,handler_owner_type,handler_symbol_id
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        handlerFile, handlerSymbol, "GET", routePath, "server", 5,
        "api.List", "*API", handlerSymbol
      );

      const routeNode = "route:server:GET:" + routePath;
      const dbNode = "db:table:public.manual_task_publications";
      insertEdge(db, {
        id: "db:repo-publications",
        from: "symbol:" + repoSymbol,
        to: dbNode,
        type: "db_read",
        sourceId: 0
      });
      for (let i = 0; i < 8; i++) {
        const noiseFile = `backend/noise/reader-${i}.go`;
        const noiseSymbol = `go:backend/noise/reader-${i}.go::ReadNoise`;
        insertFile(db, noiseFile, "go");
        insertSymbol(db, {
          id: noiseSymbol,
          file: noiseFile,
          language: "go",
          name: "ReadNoise"
        });
        insertEdge(db, {
          id: `db:noise-${i}`,
          from: "symbol:" + noiseSymbol,
          to: dbNode,
          type: "db_read",
          sourceId: 20 + i
        });
      }
      insertEdge(db, {
        id: "call:service-repo",
        from: "symbol:" + serviceSymbol,
        to: "symbol:" + repoSymbol,
        type: "call",
        sourceId: 1
      });
      insertEdge(db, {
        id: "call:handler-service",
        from: "symbol:" + handlerSymbol,
        to: "symbol:" + serviceSymbol,
        type: "call",
        sourceId: 2
      });
      insertEdge(db, {
        id: "route:handler",
        from: routeNode,
        to: "symbol:" + handlerSymbol,
        type: "route_handler",
        sourceId: 3
      });
      insertEdge(db, {
        id: "api:client-route",
        from: "symbol:" + clientSymbol,
        to: routeNode,
        type: "api_request",
        sourceId: 4
      });
      insertEdge(db, {
        id: "import:page-service",
        from: "file:" + pageFile,
        to: "file:" + clientFile,
        type: "import",
        sourceId: 5
      });
    } finally {
      db.close();
    }

    const query = queryContext({
      repoRoot: root,
      task: "人工任务在小程序只显示一个",
      maxFiles: 10
    });

    const selected = [...query.must_read, ...query.maybe_read];
    const client = selected.find((item) => item.path === "miniprogram/services/student-assignments.ts");
    const page = selected.find((item) => item.path === "miniprogram/pages/student/index.ts");

    assert.ok(client);
    assert.ok(client.reasons.includes("graph_reverse:api_request"));
    assert.ok(client.reasons.includes("intent_path_match"));

    assert.ok(page);
    assert.ok(page.reasons.includes("graph_reverse:import"));
    assert.ok(page.reasons.includes("intent_path_match"));

    assert.ok(
      query.query_expansion.graph_seed_nodes.includes(
        "db:table:public.manual_task_publications"
      )
    );
    assert.ok(query.graph_expansion.reverse_steps >= 12);
    assert.ok(query.graph_expansion.import_reverse_steps >= 1);
    assert.ok(query.graph_expansion.intent_boosted_files >= 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
