const http = require("http");
const fs = require("fs");
const path = require("path");

const resolve = (p) => path.resolve(__dirname, p);

const server = http.createServer((req, res) => {
  const url = req.url;
  console.log("request come: ", url);
  const isM3u8 = url.indexOf(".m3u8") > -1;
  const isTs = url.indexOf(".ts") > -1;
  const filePath = resolve("./source/" + url);

  if (isM3u8) {
    let xml = fs.readFileSync(filePath);
    const contentBuf = Buffer.from(xml);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", contentBuf.length);
    res.setHeader("Content-Range", `bytes ${contentBuf.length - 1}/${contentBuf.length}`);
    res.writeHead(200);
    res.write(xml);
    res.end();
  } else if (isTs) {
    res.setHeader("Content-Type", "video/mpeg");
    res.setHeader("Accept-Ranges", "bytes");
    const rs = fs.createReadStream(filePath);
    rs.pipe(res);
  } else {
    res.end();
  }
});

server.listen(1234, "0.0.0.0", () => {
  console.log("http://127.0.0.1:1234/a.m3u8");
});
