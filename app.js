// app.js

const el = (id) => document.getElementById(id);

const fileInput = el("fileInput");
const btnRun = el("btnRun");
const btnDownload = el("btnDownload");
const btnLoadDemo = el("btnLoadDemo");
const statusEl = el("status");
const imgInfoEl = el("imgInfo");

const inCanvas = el("inCanvas");
const outCanvas = el("outCanvas");
const inCtx = inCanvas.getContext("2d");
const outCtx = outCanvas.getContext("2d");

let currentImageBitmap = null;
let lastOutputBlob = null;

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

async function fetchPaletteJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`无法加载调色板：${path}`);
  const data = await res.json();
  const rgb = data.rgb;      // array of [r,g,b] 0..1
  const name = data.name;    // array of string
  if (!Array.isArray(rgb) || !Array.isArray(name) || rgb.length !== name.length) {
    throw new Error("调色板 JSON 格式不正确（需要 rgb 和 name，且长度一致）");
  }
  return { rgb, name };
}

function drawInputPreview(bitmap) {
  const maxSide = 520;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  inCanvas.width = w;
  inCanvas.height = h;
  inCtx.clearRect(0, 0, w, h);
  inCtx.drawImage(bitmap, 0, 0, w, h);
  imgInfoEl.textContent = `${bitmap.width}×${bitmap.height}`;
}

function centerCropSquareImageData(srcCtx, w, h) {
  const s = Math.min(w, h);
  const left = Math.floor((w - s) / 2);
  const top = Math.floor((h - s) / 2);
  return srcCtx.getImageData(left, top, s, s);
}

// 将正方形 imageData 裁剪到能被 pixN 整除
function cropToDivisibleSquare(imageData, pixN) {
  const s = imageData.width;
  const s2 = s - (s % pixN);
  if (s2 === s) return imageData;
  const left = 0;
  const top = 0;
  // 取左上角 s2*s2（因为已经是中心裁剪过的正方形，影响很小；你想完全一致也可以再居中裁）
  const tmp = new ImageData(s2, s2);
  const src = imageData.data;
  const dst = tmp.data;
  for (let y = 0; y < s2; y++) {
    const sy = (top + y) * s;
    const dy = y * s2;
    for (let x = 0; x < s2; x++) {
      const si = (sy + (left + x)) * 4;
      const di = (dy + x) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
  return tmp;
}

// 分块均值 -> pixN x pixN 的 RGB(0..1)
function blockMeanToSmall(imageData, pixN) {
  const s = imageData.width;
  const bs = s / pixN;
  const data = imageData.data;

  const small = new Float32Array(pixN * pixN * 3);

  for (let i = 0; i < pixN; i++) {
    for (let j = 0; j < pixN; j++) {
      let sumR = 0, sumG = 0, sumB = 0;
      let count = 0;

      const y0 = Math.floor(i * bs);
      const y1 = Math.floor((i + 1) * bs);
      const x0 = Math.floor(j * bs);
      const x1 = Math.floor((j + 1) * bs);

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * s + x) * 4;
          let r = data[idx] / 255;
          let g = data[idx + 1] / 255;
          let b = data[idx + 2] / 255;
          const a = data[idx + 3] / 255;

          // alpha < 0.5 -> white
          if (a < 0.5) { r = 1; g = 1; b = 1; }

          sumR += r; sumG += g; sumB += b;
          count++;
        }
      }

      const base = (i * pixN + j) * 3;
      small[base] = sumR / count;
      small[base + 1] = sumG / count;
      small[base + 2] = sumB / count;
    }
  }
  return small; // length pixN*pixN*3
}

// 最近邻匹配：返回每个像素匹配到的 palette index
function nearestPaletteIndices(smallRGB, paletteRGB) {
  const P = smallRGB.length / 3;
  const C = paletteRGB.length;
  const out = new Uint16Array(P);

  for (let p = 0; p < P; p++) {
    const r = smallRGB[p * 3];
    const g = smallRGB[p * 3 + 1];
    const b = smallRGB[p * 3 + 2];

    let best = 0;
    let bestD = Infinity;

    for (let c = 0; c < C; c++) {
      const pr = paletteRGB[c][0];
      const pg = paletteRGB[c][1];
      const pb = paletteRGB[c][2];
      const dr = r - pr, dg = g - pg, db = b - pb;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = c; }
    }
    out[p] = best;
  }
  return out;
}

function bincount(indices, n) {
  const c = new Uint32Array(n);
  for (let i = 0; i < indices.length; i++) c[indices[i]]++;
  return c;
}

function pickTopColors(counts, maxC) {
  // 返回 keep indices（升序）
  const pairs = [];
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > 0) pairs.push([i, counts[i]]);
  }
  pairs.sort((a, b) => b[1] - a[1]);
  const top = pairs.slice(0, Math.min(maxC, pairs.length)).map(p => p[0]);
  top.sort((a, b) => a - b);
  return top;
}

// 计算文本对比色
function textColorForRGB255(r, g, b) {
  const lum = (r + g + b) / 3;
  return lum < 128 ? "white" : "black";
}

// 自动缩小字体直到能放进 swatch
function fitFont(ctx, text, maxW, maxH, startSize, minSize) {
  for (let s = startSize; s >= minSize; s--) {
    ctx.font = `${s}px sans-serif`;
    const m = ctx.measureText(text);
    const w = m.width;
    const h = s; // 近似高度
    if (w <= maxW && h <= maxH) return s;
  }
  return minSize;
}

// 渲染输出（含 FIX 的右侧色卡）
function renderOutput({
  pixN, cellSize, fontSize, showNames, palettePos,
  swatchWRatio, swatchHRatio, gapYRatio, gapXRatio,
  ind2, paletteRGB, paletteNames, counts2
}) {
  const margin = cellSize;
  const gridW = pixN * cellSize;
  const gridH = pixN * cellSize;

  // 右侧 palette fixed swatch
  const swatchW = Math.round(swatchWRatio * cellSize);
  const swatchH = Math.round(swatchHRatio * cellSize);
  const gapY = Math.round(gapYRatio * cellSize);
  const gapX = Math.round(gapXRatio * cellSize);

  // 画布尺寸计算（尽量保持你的 Python 版布局思路）
  let outW, outH, palRows, palCols;

  if (palettePos === "bottom") {
    // 简化：底部仍可用，但你主要用 right
    const palCellW = Math.round(3.5 * cellSize);
    const palCellH = Math.round(1.5 * cellSize);
    palCols = Math.max(1, Math.floor((pixN + 1.5) / 3.5));
    const rows = Math.ceil(paletteRGB.length / palCols);
    outW = margin + gridW + cellSize;
    outH = margin + gridH + Math.round(2.5 * cellSize) + rows * palCellH;
  } else {
    palRows = Math.max(1, Math.floor((pixN + 1.5) / 1.5));
    palCols = Math.ceil(paletteRGB.length / palRows);
    outW = margin + gridW + Math.round(0.6 * cellSize) + palCols * (swatchW + gapX) + Math.round(0.6 * cellSize);
    outH = margin + gridH + margin;
  }

  outCanvas.width = outW;
  outCanvas.height = outH;

  // 背景白
  outCtx.clearRect(0, 0, outW, outH);
  outCtx.fillStyle = "white";
  outCtx.fillRect(0, 0, outW, outH);

  // 蓝色条
  const blue = "rgb(17,112,189)";
  outCtx.fillStyle = blue;
  outCtx.fillRect(0, margin + gridH, margin + gridW, margin);
  outCtx.fillRect(0, 0, margin, margin + gridH);

  // 画像素格
  for (let i = 0; i < pixN; i++) {
    for (let j = 0; j < pixN; j++) {
      const p = i * pixN + j;
      const ci = ind2[p];
      const c = paletteRGB[ci];
      const r = Math.round(c[0] * 255);
      const g = Math.round(c[1] * 255);
      const b = Math.round(c[2] * 255);

      const x0 = margin + j * cellSize;
      const y0 = margin + i * cellSize;

      outCtx.fillStyle = `rgb(${r},${g},${b})`;
      outCtx.fillRect(x0, y0, cellSize, cellSize);

      if (showNames && !(r === 255 && g === 255 && b === 255)) {
        const name = String(paletteNames[ci]);
        const tc = textColorForRGB255(r, g, b);
        outCtx.fillStyle = tc;

        outCtx.font = `${fontSize}px sans-serif`;
        const m = outCtx.measureText(name);
        const tw = m.width;
        const th = fontSize;

        outCtx.fillText(name, x0 + (cellSize - tw) / 2, y0 + (cellSize + th * 0.35) / 2);
      }
    }
  }

  // 网格线
  outCtx.strokeStyle = "black";
  outCtx.lineWidth = 1;
  for (let k = 0; k <= pixN; k++) {
    const x = margin + k * cellSize;
    const y = margin + k * cellSize;
    outCtx.beginPath();
    outCtx.moveTo(x, margin);
    outCtx.lineTo(x, margin + gridH);
    outCtx.stroke();

    outCtx.beginPath();
    outCtx.moveTo(margin, y);
    outCtx.lineTo(margin + gridW, y);
    outCtx.stroke();
  }
  // 每5格加粗
  outCtx.lineWidth = 3;
  for (let k = 0; k <= pixN; k += 5) {
    const x = margin + k * cellSize;
    const y = margin + k * cellSize;
    outCtx.beginPath();
    outCtx.moveTo(x, margin);
    outCtx.lineTo(x, margin + gridH);
    outCtx.stroke();

    outCtx.beginPath();
    outCtx.moveTo(margin, y);
    outCtx.lineTo(margin + gridW, y);
    outCtx.stroke();
  }
  outCtx.lineWidth = 1;

  // 坐标编号
  outCtx.fillStyle = "white";
  outCtx.font = `${fontSize + 2}px sans-serif`;
  for (let i = 1; i <= pixN; i++) {
    const label = String(i);

    // y axis
    const y = margin + (i - 1) * cellSize + cellSize / 2;
    const my = outCtx.measureText(label);
    outCtx.fillText(label, margin / 2 - my.width / 2, y + (fontSize + 2) * 0.35 / 2);

    // x axis
    const x = margin + (i - 1) * cellSize + cellSize / 2;
    const mx = outCtx.measureText(label);
    outCtx.fillText(label, x - mx.width / 2, margin + gridH + margin / 2 + (fontSize + 2) * 0.35 / 2);
  }

  // 色卡
  if (palettePos === "right") {
    const startX = margin + gridW + Math.round(0.6 * cellSize);
    const startY = margin;

    for (let idx = 0; idx < paletteRGB.length; idx++) {
      const rr = idx % palRows;
      const cc = Math.floor(idx / palRows);

      const x0 = startX + cc * (swatchW + gapX);
      const y0 = startY + rr * (swatchH + gapY);

      const c = paletteRGB[idx];
      const r = Math.round(c[0] * 255);
      const g = Math.round(c[1] * 255);
      const b = Math.round(c[2] * 255);

      // swatch
      outCtx.fillStyle = `rgb(${r},${g},${b})`;
      outCtx.fillRect(x0, y0, swatchW, swatchH);
      outCtx.strokeStyle = "black";
      outCtx.lineWidth = 1;
      outCtx.strokeRect(x0, y0, swatchW, swatchH);

      if (showNames) {
        const text = `${paletteNames[idx]} (${counts2[idx]})`;
        const tc = textColorForRGB255(r, g, b);
        outCtx.fillStyle = tc;

        // auto-fit
        const pad = 4;
        const maxW = Math.max(10, swatchW - 2 * pad);
        const maxH = Math.max(10, swatchH - 2 * pad);
        const fitted = fitFont(outCtx, text, maxW, maxH, Math.max(10, fontSize + 2), 8);

        outCtx.font = `${fitted}px sans-serif`;
        const m = outCtx.measureText(text);
        const tw = m.width;
        const th = fitted;

        outCtx.fillText(text, x0 + (swatchW - tw) / 2, y0 + (swatchH + th * 0.35) / 2);
      }
    }
  } else {
    // bottom（可选简化版）
    const palCellW = Math.round(3.5 * cellSize);
    const palCellH = Math.round(1.5 * cellSize);
    const palColsB = Math.max(1, Math.floor((pixN + 1.5) / 3.5));
    const startY = margin + gridH + Math.round(1.5 * cellSize);

    for (let idx = 0; idx < paletteRGB.length; idx++) {
      const rr = Math.floor(idx / palColsB);
      const cc = idx % palColsB;

      const x0 = 0 + cc * palCellW;
      const y0 = startY + rr * palCellH;

      const c = paletteRGB[idx];
      const r = Math.round(c[0] * 255);
      const g = Math.round(c[1] * 255);
      const b = Math.round(c[2] * 255);

      outCtx.fillStyle = `rgb(${r},${g},${b})`;
      outCtx.fillRect(x0, y0, Math.round(3 * cellSize), Math.round(1 * cellSize));
      outCtx.strokeStyle = "black";
      outCtx.strokeRect(x0, y0, Math.round(3 * cellSize), Math.round(1 * cellSize));

      if (showNames) {
        const text = `${paletteNames[idx]} (${counts2[idx]})`;
        outCtx.fillStyle = textColorForRGB255(r, g, b);
        outCtx.font = `${fontSize + 2}px sans-serif`;
        outCtx.fillText(text, x0 + Math.round(3 * cellSize) + 6, y0 + Math.round(0.7 * cellSize));
      }
    }
  }

  // 返回 canvas 作为下载源
  return outCanvas;
}

async function run() {
  if (!currentImageBitmap) {
    alert("请先上传图片");
    return;
  }
  btnRun.disabled = true;
  btnDownload.disabled = true;
  setStatus("加载调色板...");

  try {
    const pixN = parseInt(el("pixN").value, 10);
    const maxC = parseInt(el("maxC").value, 10);
    const showNames = el("showNames").checked;
    const fontSize = parseInt(el("fontSize").value, 10);
    const cellSize = parseInt(el("cellSize").value, 10);
    const palettePos = el("palettePos").value;
    const paletteFile = el("paletteFile").value;

    const swatchWRatio = parseFloat(el("swatchW").value);
    const swatchHRatio = parseFloat(el("swatchH").value);
    const gapYRatio = parseFloat(el("gapY").value);
    const gapXRatio = parseFloat(el("gapX").value);

    const palette = await fetchPaletteJson(paletteFile);

    setStatus("读取图片像素...");
    // 把图片画到一个临时canvas以获取像素
    const tmp = document.createElement("canvas");
    const tctx = tmp.getContext("2d");
    tmp.width = currentImageBitmap.width;
    tmp.height = currentImageBitmap.height;
    tctx.drawImage(currentImageBitmap, 0, 0);

    // center crop square
    let imageData = centerCropSquareImageData(tctx, tmp.width, tmp.height);
    imageData = cropToDivisibleSquare(imageData, pixN);

    setStatus("分块均值...");
    const small = blockMeanToSmall(imageData, pixN);

    setStatus("第一次最近色匹配 & 统计...");
    const ind1 = nearestPaletteIndices(small, palette.rgb);
    const counts1 = bincount(ind1, palette.rgb.length);

    const keep = pickTopColors(counts1, maxC);
    const palRGB = keep.map(i => palette.rgb[i]);
    const palNames = keep.map(i => palette.name[i]);

    setStatus("第二次最近色匹配...");
    const ind2 = nearestPaletteIndices(small, palRGB);
    const counts2 = bincount(ind2, palRGB.length);

    setStatus("渲染输出...");
    renderOutput({
      pixN, cellSize, fontSize, showNames, palettePos,
      swatchWRatio, swatchHRatio, gapYRatio, gapXRatio,
      ind2, paletteRGB: palRGB, paletteNames: palNames, counts2
    });

    setStatus("完成 ✅");
    btnDownload.disabled = false;

    // prepare download blob
    lastOutputBlob = await new Promise(resolve => outCanvas.toBlob(resolve, "image/png"));
  } catch (e) {
    console.error(e);
    alert(String(e));
    setStatus("出错了");
  } finally {
    btnRun.disabled = false;
  }
}

function download() {
  if (!lastOutputBlob) return;
  const url = URL.createObjectURL(lastOutputBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "pixel_art.png";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

fileInput.addEventListener("change", async (ev) => {
  const f = ev.target.files?.[0];
  if (!f) return;
  setStatus("读取图片...");
  const bitmap = await createImageBitmap(f);
  currentImageBitmap = bitmap;
  drawInputPreview(bitmap);
  setStatus("");
});

btnRun.addEventListener("click", run);
btnDownload.addEventListener("click", download);

// 可选：载入一个简单 demo（纯色渐变图）
btnLoadDemo.addEventListener("click", async () => {
  const demo = document.createElement("canvas");
  demo.width = 480;
  demo.height = 320;
  const ctx = demo.getContext("2d");

  const grd = ctx.createLinearGradient(0, 0, demo.width, demo.height);
  grd.addColorStop(0, "#ff6a00");
  grd.addColorStop(0.5, "#00d4ff");
  grd.addColorStop(1, "#7fff00");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, demo.width, demo.height);

  ctx.fillStyle = "rgba(0,0,0,0.15)";
  ctx.font = "48px sans-serif";
  ctx.fillText("DEMO", 30, 80);

  const blob = await new Promise(resolve => demo.toBlob(resolve, "image/png"));
  const bitmap = await createImageBitmap(blob);
  currentImageBitmap = bitmap;
  drawInputPreview(bitmap);
});
