const http = require("http");
const fs = require("fs");
const path = require("path");

const resolve = (p) => path.resolve(__dirname, p);
const tpl = fs.readFileSync(resolve("./source/live.m3u8"), { encoding: "utf-8" });
const mch = tpl.match(/#EXTINF:[\d.]+/g);
const numMch = mch.map((v) => {
  return +v.replace("#EXTINF:", "");
});
const segs = numMch.reduce((a, b) => {
  if (Array.isArray(a)) {
    return [...a, a[a.length - 1] + b];
  }
  return [a, a + b];
});

// 总秒数
const sum = ~~numMch.reduce((a, b) => {
  return a + b;
});

// 模拟主播开播时间
const startTime = Date.now();

// 模板头
const template = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:17
`;

// 渲染完整模板
function renderXml() {
  let xml = template;
  const timeGap = (Date.now() - startTime) / 1000;
  let idx;
  if (timeGap < sum) {
    idx = segs.findIndex((v) => {
      return timeGap < v;
    });
  } else {
    const r = timeGap % sum;
    idx = segs.findIndex((v) => {
      return timeGap < r;
    });
  }
  xml += `#EXT-X-MEDIA-SEQUENCE:${Math.max(idx, 0)}\n`;
  for (let i = idx - 2; i <= idx + 2; i++) {
    console.log(i, mch[i]);
    if (i >= 0 && i < mch.length) {
      // xml += `#EXTINF:0\nlive_0${mch.length + i}.ts\n`;
    } else {
      xml += `${mch[i]}\nlive_0${i < 10 ? "0" + i : i}.ts\n`;
    }
  }
  console.log(timeGap, idx);
  return xml;
}

const server = http.createServer((req, res) => {
  const url = req.url;
  console.log("request come: ", url);
  const isM3u8 = url.indexOf(".m3u8") > -1;
  const isTs = url.indexOf(".ts") > -1;

  if (isM3u8) {
    const m3u8Xml = renderXml();
    // const contentBuf = Buffer.from(template);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    // res.setHeader("Accept-Ranges", "bytes");
    // res.setHeader("Content-Length", contentBuf.length);
    // res.setHeader("Content-Range", `bytes ${contentBuf.length - 1}/${contentBuf.length}`);
    res.writeHead(200);
    res.write(m3u8Xml);
    res.end();
  } else if (isTs) {
    const str = url.split("?t=")[0];
    const filePath = resolve("./source/" + str);
    // res.setHeader("Content-Type", "video/mpeg");
    // res.setHeader("Accept-Ranges", "bytes");
    const rs = fs.createReadStream(filePath);
    rs.pipe(res);
  } else {
    res.end("ok");
  }
});

server.listen(1234, "0.0.0.0", () => {
  console.log("http://127.0.0.1:1234/live.m3u8");
});
