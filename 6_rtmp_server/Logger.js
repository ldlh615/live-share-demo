const fs = require("fs");
const path = require("path");
const { isBuffer } = require("util");

const logPath = path.resolve(__dirname, "./rtmp.log");
const ws = fs.createWriteStream(logPath, { encoding: "utf-8" });

function log() {
  console.log(...arguments);
  const s = [...arguments];
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    if (isBuffer(v)) {
      let j = 0;
      let str = "";
      while (j < v.length) {
        str += v[j];
        j++;
      }
      s[i] = str;
    }
  }
  ws.write(s.join(" ").toString() + "\n");
}

module.exports = {
  log,
};
