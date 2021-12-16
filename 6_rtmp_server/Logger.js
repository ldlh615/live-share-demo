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
    if (Buffer.isBuffer(v)) {
      let j = 0;
      let str = "[";
      while (j < v.length) {
        str += v[j].toString(16) + " ";
        j++;
      }
      str += "]";
      s[i] = str;
    } else if (Object.prototype.toString.call(v) === "[object Object]") {
      s[i] = JSON.stringify(v);
    }
  }
  ws.write(s.join(" ").toString() + "\n");
}

module.exports = {
  log,
};
