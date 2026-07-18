"use strict";

function redirect(res, location, headers = {}) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end();
  return true;
}

function textResponse(
  res,
  status,
  body,
  type = "text/plain; charset=utf-8",
  headers = {},
) {
  const data = Buffer.from(String(body));
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
  return true;
}

module.exports = { redirect, textResponse };
