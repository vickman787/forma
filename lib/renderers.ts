import { mkdir, writeFile, readFile, copyFile, stat } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { ZipArchive } from "archiver";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import ffmpegStatic from "ffmpeg-static";
import { type Brief, type Order, escapeHtml as e } from "./domain";
import { type Content } from "./provider";
import { config } from "./config";
import { database } from "./db";
import { wrapText as lines } from "./text";
import { readableInk, readableAccent } from "./colors";
const svgText = (s: string) => e(s);
let textMeasure: PDFKit.PDFDocument | undefined;
function constrainText(line: string, size: number, width: number) {
  if (!textMeasure) {
    textMeasure = new PDFDocument({ autoFirstPage: false });
    pdfFont(textMeasure);
  }
  const measured = textMeasure.fontSize(size).widthOfString(line);
  return measured > width
    ? ` textLength="${width}" lengthAdjust="spacingAndGlyphs"`
    : "";
}
function svgLines(
  text: string,
  x: number,
  y: number,
  size: number,
  widthChars: number,
  color = "#172B36",
  gap = 1.2,
) {
  return lines(text, widthChars)
    .map(
      (line, i) =>
        `<text x="${x}" y="${y + i * size * gap}" font-size="${size}" fill="${color}"${constrainText(line, size, 1080 - x - 100)}>${svgText(line)}</text>`,
    )
    .join("");
}
function svg(w: number, h: number, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#F7F5F0"/><g font-family="Arial, sans-serif">${body}</g></svg>`;
}
export type Rendered = { name: string; mime: string; path: string }[];
function pdfFont(doc: PDFKit.PDFDocument) {
  const font =
    process.platform === "win32"
      ? "C:/Windows/Fonts/arial.ttf"
      : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  if (existsSync(font)) doc.font(font);
}
async function pdf(
  file: string,
  draw: (doc: PDFKit.PDFDocument) => void,
  opts: PDFKit.PDFDocumentOptions = {},
) {
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, ...opts }),
      stream = createWriteStream(file);
    doc.pipe(stream);
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);
    pdfFont(doc);
    draw(doc);
    doc.end();
  });
}
function pdfHeader(doc: PDFKit.PDFDocument, b: Brief, label: string) {
  doc
    .fillColor("#D75B3E")
    .fontSize(10)
    .text(label.toUpperCase(), { characterSpacing: 2 });
  doc.moveDown();
  doc.fillColor("#172B36").fontSize(26).text(b.businessName);
  doc.moveDown(0.5);
  doc.fillColor("#596970").fontSize(11).text(b.location);
  doc.moveDown(1.6);
}
async function command(bin: string, args: string[], timeout = 180000) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, windowsHide: true });
    let output = "";
    child.stderr.on("data", (d) => {
      output = (output + String(d)).slice(-6000);
    });
    child.stdout.on("data", (d) => {
      output = (output + String(d)).slice(-6000);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Renderer exceeded its time limit."));
    }, timeout);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(output)
        : reject(new Error(`Renderer failed (${code}): ${output.slice(-500)}`));
    });
  });
}
export async function render(o: Order, content: Content): Promise<Rendered> {
  const dir = path.join(config().data, "artifacts", o.id, `v${o.version}`);
  await mkdir(dir, { recursive: true });
  const b = o.brief,
    result: Rendered = [];
  const add = (name: string, mime: string) => {
    const file = path.join(dir, name);
    result.push({ name, mime, path: file });
    return file;
  };
  const assets: string[] = [];
  for (const id of b.assetIds) {
    const [a] = await (
      await database()
    ).query("SELECT storage_key FROM uploads WHERE id=$1 AND owner=$2", [
      id,
      o.owner,
    ]);
    if (!a) throw new Error("Approved asset missing");
    assets.push(path.join(config().data, a.storage_key));
  }
  const photoData = assets[0]
    ? `data:image/png;base64,${(await readFile(assets[0])).toString("base64")}`
    : null;
  if (b.service === "business_website") {
    const sections = b.sections
      .map(
        (section, i) =>
          `<section id="${section === "Contact" ? "contact" : `section-${i}`}"><span class="eyebrow">${e(section)}</span>${section === "Welcome" ? `<h1>${e(content.headline)}</h1><p>${e(content.sections.find((s) => s.title === section)?.text || content.body)}</p>${assets.length ? `<img src="photo-0.png" alt="Customer-approved business photograph">` : ""}<a class="button" href="#contact">${e(b.cta)}</a>` : section === "Menu & prices" ? `<h2>Our menu & prices</h2><dl>${b.items.map((item) => `<div><dt>${e(item.name)}</dt><dd>${e(item.currency)} ${e(item.price)}</dd></div>`).join("")}</dl>` : section === "Gallery" ? assets.map((_, i) => `<img src="photo-${i}.png" alt="Customer-approved photo ${i + 1}" loading="lazy">`).join("") || "<p>Discover our business in person.</p>" : section === "Contact" ? `<h2>Let’s connect.</h2><p>${e(b.location)}</p><p>${e(b.contact)}</p>` : `<h2>${e(section === "About" ? "A little about us." : "Made for you.")}</h2><p>${e(content.sections.find((s) => s.title === section)?.text || (section === "About" ? b.description : content.body))}</p>`}</section>`,
      )
      .join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(b.businessName)}</title><meta name="description" content="${e(b.description.slice(0, 160))}"><style>*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f7f5f0;color:#172b36;font:18px/1.7 Arial,sans-serif;overflow-wrap:anywhere}header,main,footer{max-width:1100px;margin:auto;padding:32px 6vw}header{border-bottom:1px solid #dfdfd8;display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}header strong{font:28px Georgia,serif}nav{display:flex;flex-wrap:wrap;gap:16px}a{color:inherit}section{padding:64px 0;border-bottom:1px solid #dfdfd8}section:first-child{padding:80px 0}h1{font:clamp(44px,7vw,84px)/1.05 Georgia,serif;max-width:800px;margin:24px 0;color:${readableAccent(b.color)}}h2{font:38px Georgia,serif}p{max-width:720px;white-space:pre-line}.eyebrow{font-size:13px;letter-spacing:2px;text-transform:uppercase}.button{display:inline-block;padding:14px 22px;background:#172b36;color:white;border-radius:8px;margin-top:16px}dl>div{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #dfdfd8;padding:20px 0}img{width:100%;max-width:500px;border-radius:12px}footer{font-size:14px}a:focus-visible{outline:3px solid #d75b3e;outline-offset:5px}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}</style></head><body><header><strong>${e(b.businessName)}</strong><nav>${b.sections.map((s, i) => `<a href="#${s === "Contact" ? "contact" : `section-${i}`}">${e(s)}</a>`).join("")}</nav></header><main>${sections}${b.sections.includes("Contact") ? "" : `<section id="contact"><h2>${e(b.cta)}</h2><p>${e(b.contact)}</p><p>${e(b.location)}</p></section>`}</main><footer>${e(b.businessName)} · Made with Forma</footer></body></html>`;
    await writeFile(add("index.html", "text/html; charset=utf-8"), html);
    for (let i = 0; i < assets.length; i++)
      await copyFile(assets[i], add(`photo-${i}.png`, "image/png"));
    const zipPath = add("website-source.zip", "application/zip");
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(zipPath),
        archive = new ZipArchive({ zlib: { level: 9 } });
      stream.on("close", resolve);
      stream.on("error", reject);
      archive.on("error", reject);
      archive.pipe(stream);
      archive.append(html, { name: "index.html" });
      for (let i = 0; i < assets.length; i++)
        archive.file(assets[i], { name: `photo-${i}.png` });
      archive.append(
        "Open index.html in a browser. No build step, external fonts, tracking, or backend required.\n",
        { name: "README.txt" },
      );
      void archive.finalize();
    });
  }
  if (b.service === "flyers_price_list") {
    // Never print an internal task label as the customer's promotional headline.
    // Fall back to the approved brief rather than inventing replacement claims.
    const headline =
      b.offer ||
      (/\b(?:flyer|video|website|price list)\s+(?:copy|content)\b/i.test(
        content.headline,
      )
        ? b.description
        : content.headline);
    const headlineLines = lines(headline, 20);
    if (headlineLines.length > 6)
      throw new Error(
        "Flyer headline is too long for safe text bounds. Shorten the offer.",
      );
    const body = svg(
      1080,
      1350,
      `<rect x="36" y="36" width="1008" height="1278" rx="12" fill="${b.color}"/><rect x="70" y="70" width="940" height="1210" fill="#f7f5f0"/>${svgLines(b.businessName, 120, 160, 32, 43)}<line x1="120" x2="960" y1="210" y2="210" stroke="#dfdfd8"/>${svgLines(headline, 120, 330, 74, 20)}${photoData ? `<image href="${photoData}" x="120" y="${330 + (headlineLines.length - 1) * 88.8 + 45}" width="840" height="${Math.min(280, 900 - (330 + (headlineLines.length - 1) * 88.8 + 45))}" preserveAspectRatio="xMidYMid slice"/>` : ""}${svgLines(b.cta, 120, 950, 38, 35)}${b.expiry ? svgLines(`Offer ends ${b.expiry}`, 120, 1025, 22, 50) : ""}${svgLines(b.location, 120, 1060, 28, 48)}${svgLines(b.contact, 120, 1160, 26, 55)}<text x="120" y="1240" font-size="18" fill="#596970">Made with Forma</text>`,
    );
    const png = await sharp(Buffer.from(body)).png().toBuffer();
    await writeFile(add("promotional-flyer.png", "image/png"), png);
    await pdf(
      add("promotional-flyer.pdf", "application/pdf"),
      (doc) => {
        doc.image(png, 0, 0, { width: 540, height: 675 });
      },
      { size: [540, 675], margin: 0 },
    );
    await pdf(add("price-list.pdf", "application/pdf"), (doc) => {
      pdfHeader(doc, b, "Price list");
      b.items.forEach((item) => {
        const rowHeight =
          Math.max(
            doc.heightOfString(item.name, { width: 280 }),
            doc.heightOfString(`${item.currency} ${item.price}`, {
              width: 160,
            }),
          ) + 24;
        if (doc.y + rowHeight > doc.page.height - 90) {
          doc.addPage();
          pdfHeader(doc, b, "Price list · continued");
        }
        const y = doc.y;
        doc
          .fillColor("#172B36")
          .fontSize(12)
          .text(item.name, 48, y, { width: 280 });
        doc.text(`${item.currency} ${item.price}`, 340, y, {
          width: 205,
          align: "right",
        });
        doc.y = y + rowHeight;
        doc
          .moveTo(48, doc.y - 12)
          .lineTo(547, doc.y - 12)
          .strokeColor("#DFDFD8")
          .stroke();
      });
      doc.moveDown();
      doc
        .fillColor("#596970")
        .fontSize(10)
        .text(b.contact, 48, doc.y, { width: 499, align: "left" })
        .text(b.location);
    });
  }
  if (b.service === "promo_video") {
    const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
    if (!ffmpeg || !existsSync(ffmpeg))
      throw new Error("Video renderer is unavailable. Configure FFMPEG_PATH.");
    const scenes = [
      b.businessName,
      b.offer || content.scenes[1],
      content.scenes[2] || b.location,
      b.cta,
    ];
    for (let i = 0; i < 4; i++) {
      if (lines(scenes[i], 23).length > 8)
        throw new Error("Scene text exceeds safe bounds. Shorten your offer.");
      const foreground = i % 2 ? readableInk(b.color) : "#f7f5f0";
      const frame = svg(
        1080,
        1920,
        `<rect x="0" y="0" width="1080" height="1920" fill="${i % 2 ? b.color : "#172B36"}"/><circle cx="980" cy="200" r="360" fill="#ffffff" opacity=".05"/>${photoData ? `<image href="${photoData}" x="100" y="330" width="880" height="220" preserveAspectRatio="xMidYMid slice"/>` : ""}<g fill="${foreground}">${svgLines(b.businessName, 100, 220, 30, 44, foreground)}${svgLines(scenes[i], 100, 650, 70, 23, foreground, 1.3)}${svgLines(b.contact, 100, 1550, 30, 42, foreground)}<text x="100" y="1740" font-size="22">${i + 1} / 4 · Made with Forma</text></g>`,
      );
      await sharp(Buffer.from(frame))
        .png()
        .toFile(path.join(dir, `scene-${i}.png`));
    }
    const args = ["-y"];
    for (let i = 0; i < 4; i++)
      args.push(
        "-loop",
        "1",
        "-t",
        "3.5",
        "-i",
        path.join(dir, `scene-${i}.png`),
      );
    args.push(
      "-filter_complex",
      "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p[v]",
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "24",
      "-r",
      "24",
      "-t",
      "14",
      "-movflags",
      "+faststart",
      "-threads",
      "2",
      add("promo-vertical.mp4", "video/mp4"),
    );
    await command(ffmpeg, args);
    await copyFile(
      path.join(dir, "scene-0.png"),
      add("poster.png", "image/png"),
    );
    await writeFile(
      add("captions.txt", "text/plain; charset=utf-8"),
      [b.businessName, b.offer, b.description, b.cta, b.contact, b.location]
        .filter(Boolean)
        .join("\n\n"),
    );
    const metadata = await command(ffmpeg, [
      "-i",
      path.join(dir, "promo-vertical.mp4"),
      "-f",
      "null",
      "-",
    ]);
    if (!metadata.includes("1080x1920") || !metadata.includes("00:00:14"))
      throw new Error("Video dimensions or duration check failed");
  }
  if (b.service === "market_report") {
    const reviewNotice =
      "REVIEW DRAFT: Check publication dates, source access and claim support before acting. Older industry coverage does not establish current customer demand.";
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(b.businessName)} · Market brief</title><style>body{margin:0 auto;max-width:800px;padding:40px 6vw;background:#f7f5f0;color:#172b36;font:18px/1.7 Arial}h1,h2{font-family:Georgia}h1{font-size:42px}.note{padding:20px;background:#e2eadd}a{overflow-wrap:anywhere;color:#172b36}section{border-bottom:1px solid #dfdfd8;padding:24px 0}</style></head><body><p>FORMA · MARKET BRIEF · REVIEW DRAFT</p><h1>${e(b.businessName)}</h1><p>${e(b.question)} · ${e(b.location)}</p>${reviewNotice ? `<p class="note">${e(reviewNotice)}</p>` : ""}<p class="note">${e(content.limitations)}</p>${content.sections.map((s) => `<section><p>${s.inference ? "Inference / planning suggestion" : "Sourced finding"}</p><h2>${e(s.title)}</h2><p>${e(s.text)}</p>${s.sourceUrls.map((url) => `<a href="${e(url)}" rel="noreferrer">${e(url)}</a><br>`).join("")}</section>`).join("")}<h2>Sources</h2>${content.sources.length ? content.sources.map((s) => `<p><a href="${e(s.url)}">${e(s.title)}</a> · Retrieved ${new Date().toISOString().slice(0, 10)}</p>`).join("") : "<p>No web research performed. No verified sources.</p>"}</body></html>`;
    await writeFile(add("market-brief.html", "text/html; charset=utf-8"), html);
    await pdf(add("market-brief.pdf", "application/pdf"), (doc) => {
      pdfHeader(doc, b, "Market brief · review draft");
      doc.fontSize(12).fillColor("#172B36").text(b.question).moveDown();
      if (reviewNotice) doc.fontSize(10).text(reviewNotice).moveDown();
      doc.fontSize(10).text(content.limitations).moveDown(2);
      for (const s of content.sections) {
        if (doc.y > 650) doc.addPage();
        doc.fontSize(17).text(s.title).moveDown(0.5);
        doc
          .fontSize(10)
          .text(
            s.inference ? "Inference / planning suggestion" : "Sourced finding",
          )
          .moveDown(0.5);
        doc.fontSize(12).text(s.text).moveDown();
        for (const url of s.sourceUrls)
          doc.fontSize(9).text(url, { link: url }).moveDown();
        doc.moveDown();
      }
      doc.addPage();
      doc.fontSize(20).text("Sources").moveDown();
      if (!content.sources.length)
        doc
          .fontSize(12)
          .text("No web research performed. No verified sources.");
      for (const s of content.sources)
        doc
          .fontSize(11)
          .text(s.title)
          .fontSize(9)
          .text(s.url, { link: s.url })
          .text(`Retrieved ${new Date().toISOString()}`)
          .moveDown();
    });
    const csv = (value: string) =>
      '"' + value.replace(/"/g, '""').replace(/^[=+@\-]/, "'$&") + '"';
    await writeFile(
      add("sources.csv", "text/csv; charset=utf-8"),
      "title,url,retrieved_at\r\n" +
        content.sources
          .map((s) =>
            [s.title, s.url, new Date().toISOString()].map(csv).join(","),
          )
          .join("\r\n"),
    );
  }
  for (const file of result) {
    const info = await stat(file.path);
    if (info.size === 0 || info.size > 80 * 1024 * 1024)
      throw new Error("Artifact size check failed");
  }
  return result;
}
