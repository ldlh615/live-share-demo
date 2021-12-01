const http = require("http");
const fs = require("fs");
const path = require("path");

const resolve = (p) => path.resolve(__dirname, p);

// let i = 0;
// setInterval(() => {
//   i += 1;
//   console.log(i);
// }, 1000);

const server = http.createServer((req, res) => {
  const url = req.url;
  console.log("request come: ", url);
  const isM3u8 = url.indexOf(".m3u8") > -1;
  const isTs = url.indexOf(".ts") > -1;

  if (isM3u8) {
    const filePath = resolve("./source/live.m3u8");
    const now = new Date();
    let xml = fs.readFileSync(filePath, { encoding: "utf-8" });
    // xml = xml.replace(/(\$DATE)/g, parseInt(now.getTime() / 100));
    // xml = xml.replace(/(\$DATE)/g, 1619782246);
    // xml = xml.replace(/(\$RANDOM)/g, Math.random());
    // xml = xml.replace("$TIME", '2021-11-29T14:06:21Z');
    // xml = xml.replace("$TIME", '2021-11-29T14:06:31Z');
    // xml = xml.replace("$TIME", new Date(d.getTime() + 10000).toISOString());
    // xml = xml.replace("$TIME", new Date(d.getTime() + 20000).toISOString());
    // console.log(xml);
    const contentBuf = Buffer.from(xml);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", contentBuf.length);
    res.setHeader("Content-Range", `bytes ${contentBuf.length - 1}/${contentBuf.length}`);
    res.writeHead(200);
    res.write(xml);
    res.end();
  } else if (isTs) {
    const str = url.split("?t=")[0];
    const filePath = resolve("./source/" + str);
    res.setHeader("Content-Type", "video/mpeg");
    res.setHeader("Accept-Ranges", "bytes");
    const rs = fs.createReadStream(filePath);
    rs.pipe(res);
  } else {
    res.end("ok");
  }
});

server.listen(1234, "0.0.0.0", () => {
  console.log("http://127.0.0.1:1234/live.m3u8");
});
