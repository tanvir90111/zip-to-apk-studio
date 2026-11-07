const MAX_ZIP = 25 * 1024 * 1024;
const APP_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const json = (d, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const authed = (req, env) => {
  if (!env.BUILD_TOKEN) return false;
  const enc = new TextEncoder();
  const a = enc.encode(req.headers.get("authorization") || "");
  const b = enc.encode(`Bearer ${env.BUILD_TOKEN}`);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
};

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    let m;
    try {
      if (req.method === "GET" && p === "/api/config")
        return json({ codeRequired: !!env.ACCESS_CODE, maxMB: MAX_ZIP / 1048576 });
      if (req.method === "POST" && p === "/api/build") return build(req, env);
      if (req.method === "GET" && (m = p.match(/^\/api\/status\/([0-9a-f-]{36})$/))) return status(m[1], env);
      if (req.method === "GET" && (m = p.match(/^\/api\/download\/([0-9a-f-]{36})$/))) return download(m[1], env);

      if ((m = p.match(/^\/api\/internal\/(input|apk|status)\/([0-9a-f-]{36})$/))) {
        if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
        return internal(req, env, m[1], m[2]);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "server error" }, 500);
    }
  },
};

async function build(req, env) {
  const form = await req.formData();
  if (env.ACCESS_CODE && form.get("code") !== env.ACCESS_CODE) return json({ error: "Wrong access code" }, 401);

  const file = form.get("zip");
  if (!file || typeof file === "string") return json({ error: "ZIP file missing" }, 400);
  if (file.size > MAX_ZIP) return json({ error: "ZIP is too large (max 25 MB)" }, 413);
  const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!(magic[0] === 0x50 && magic[1] === 0x4b)) return json({ error: "Not a valid ZIP file" }, 400);

  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const rlKey = `rl:${ip}:${Math.floor(Date.now() / 3600000)}`;
  const used = parseInt((await env.KV.get(rlKey)) || "0", 10);
  if (used >= parseInt(env.HOURLY_LIMIT || "5", 10)) return json({ error: "Hourly build limit reached" }, 429);
  await env.KV.put(rlKey, String(used + 1), { expirationTtl: 7200 });

  const id = crypto.randomUUID();
  const name =
    String(form.get("appName") || "").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 30) || "My App";
  let appId = String(form.get("appId") || "").trim().toLowerCase();
  if (!appId) appId = `com.zip2apk.app${id.slice(0, 8).replace(/-/g, "")}`;
  if (appId.length > 60 || !APP_ID_RE.test(appId))
    return json({ error: "Package ID must look like com.example.myapp" }, 400);

  await env.BUCKET.put(`in/${id}.zip`, await file.arrayBuffer());
  await env.KV.put(id, JSON.stringify({ status: "queued", message: "Waiting for builder", name }), {
    expirationTtl: 86400,
  });

  const gh = await fetch(
    `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/build.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "zip-to-apk-studio",
        "X-GitHub-Api-Version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ref: env.GH_REF || "main",
        inputs: { job_id: id, app_name: name, app_id: appId, worker_url: new URL(req.url).origin },
      }),
    }
  );
  if (!gh.ok) {
    await setStatus(env, id, "failed", "Could not start the builder");
    return json({ error: "Could not start the builder" }, 502);
  }
  return json({ id });
}

async function setStatus(env, id, st, message) {
  const raw = await env.KV.get(id);
  if (!raw) return false;
  const job = JSON.parse(raw);
  job.status = st;
  job.message = String(message || "").slice(0, 500);
  await env.KV.put(id, JSON.stringify(job), { expirationTtl: 86400 });
  if (st === "done" || st === "failed") await env.BUCKET.delete(`in/${id}.zip`);
  return true;
}

async function status(id, env) {
  const raw = await env.KV.get(id);
  if (!raw) return json({ status: "failed", message: "Job not found or expired" }, 404);
  const j = JSON.parse(raw);
  return json({ status: j.status, message: j.message, download: j.status === "done" ? `/api/download/${id}` : null });
}

async function download(id, env) {
  const raw = await env.KV.get(id);
  const obj = raw && (await env.BUCKET.get(`out/${id}.apk`));
  if (!obj) return json({ error: "APK not found or expired" }, 404);
  const base = JSON.parse(raw).name.replace(/[^A-Za-z0-9_-]+/g, "_") || "app";
  return new Response(obj.body, {
    headers: {
      "content-type": "application/vnd.android.package-archive",
      "content-disposition": `attachment; filename="${base}.apk"`,
    },
  });
}

async function internal(req, env, kind, id) {
  if (kind === "input" && req.method === "GET") {
    const obj = await env.BUCKET.get(`in/${id}.zip`);
    return obj ? new Response(obj.body) : json({ error: "gone" }, 404);
  }
  if (kind === "apk" && req.method === "PUT") {
    await env.BUCKET.put(`out/${id}.apk`, req.body);
    return json({ ok: true });
  }
  if (kind === "status" && req.method === "POST") {
    const { status: st, message } = await req.json();
    if (!["building", "done", "failed"].includes(st)) return json({ error: "bad status" }, 400);
    return json({ ok: await setStatus(env, id, st, message) });
  }
  return json({ error: "method not allowed" }, 405);
}
