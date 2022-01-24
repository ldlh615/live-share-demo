const http = require("http");
const fs = require("fs");
const path = require("path");

const resolve = (p) => path.resolve(__dirname, p);
const tpl = fs.readFileSync(resolve("./source/play.m3u8"), { encoding: "utf-8" });
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

console.log(mch);
console.log(numMch);
console.log(segs);
console.log(sum);

// 模拟主播开播时间
const startTime = Date.now();

// 模板头
const template = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-ALLOW-CACHE:YES
#EXT-X-TARGETDURATION:9
`;

// 渲染完整模板
function renderXml() {
  let xml = template;
  const totalGap = (Date.now() - startTime) / 1000;
  const timeGap = totalGap >= sum ? totalGap % sum : totalGap;
  const loopNum = Math.floor(totalGap / sum);
  const idx = segs.findIndex((v) => {
    return timeGap <= v;
  });
  const seq = loopNum * 31 + idx || 0;
  console.log(totalGap, timeGap, loopNum, idx);

  xml += `#EXT-X-MEDIA-SEQUENCE:${seq}\n`;
  for (let i = idx - 2; i <= idx + 2; i++) {
    if (i < 0) {
      if (loopNum > 0) {
        const j = mch.length + i;
        xml += `${mch[j]}\nlive_${j}.ts\n`;
      }
    } else if (i >= mch.length - 1) {
      const j = i % mch.length;
      xml += `${mch[j]}\nlive_${j}.ts\n`;
    } else {
      xml += `${mch[i]}\nlive_${i}.ts\n`;
    }
  }
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
