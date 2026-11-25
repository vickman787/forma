/** Explicit offline fixture check, run only in a disposable QA container/volume. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { render } from "../lib/renderers.ts";
import { blankBrief, serviceIds } from "../lib/domain.ts";
if (
  process.env.FORMA_CONTAINER_QA !== "true" ||
  process.env.OPENAI_API_KEY ||
  process.env.FORMA_DEPLOYER_PRIVATE_KEY ||
  process.env.ALLOW_PAID_API_CALLS === "true"
)
  throw new Error("Disposable keyless offline QA environment required");
for (const service of serviceIds) {
  const brief = {
    ...blankBrief(service),
    businessName: "Isolated render check",
    description: "Approved fixture details for offline container verification.",
    location: "Lagos",
    industry: "Services",
    audience: "Local customers",
    contact: "help@example.invalid",
    offer: "Creative work for your business",
    question: "What should this fixture investigate?",
    items: [{ name: "Consultation", price: "15000", currency: "NGN" }],
  };
  const content = {
    headline: "Creative work for your business",
    body: brief.description,
    scenes: [
      brief.businessName,
      "Creative work for your business",
      brief.location,
      "Get in touch",
    ],
    sections: [
      {
        title: "Evidence",
        text: "This is an isolated rendering check, not researched market evidence.",
        sourceUrls: ["https://example.invalid/fixture"],
        inference: true,
      },
    ],
    sources: [
      { title: "Fixture only", url: "https://example.invalid/fixture" },
    ],
    limitations: "Offline runtime fixture only.",
  };
  const files = await render(
    { id: `container-qa-${service}`, owner: "qa", version: 1, brief },
    content,
  );
  for (const file of files) {
    const bytes = await readFile(file.path);
    assert.ok(bytes.length > 20);
    if (file.name.endsWith(".pdf"))
      assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
    if (file.name.endsWith(".png"))
      assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    if (file.name.endsWith(".zip")) {
      const end = bytes.lastIndexOf(Buffer.from("504b0506", "hex"));
      assert.ok(end > 0);
      let position = bytes.readUInt32LE(end + 16),
        found = false;
      for (let n = 0; n < bytes.readUInt16LE(end + 10); n++) {
        assert.equal(bytes.readUInt32LE(position), 0x02014b50);
        const length = bytes.readUInt16LE(position + 28),
          name = bytes
            .subarray(position + 46, position + 46 + length)
            .toString();
        if (name === "index.html") {
          const local = bytes.readUInt32LE(position + 42),
            start =
              local +
              30 +
              bytes.readUInt16LE(local + 26) +
              bytes.readUInt16LE(local + 28);
          const compressed = bytes.subarray(
            start,
            start + bytes.readUInt32LE(position + 20),
          );
          const decoded =
            bytes.readUInt16LE(position + 10) === 8
              ? inflateRawSync(compressed)
              : compressed;
          assert.deepEqual(
            decoded,
            await readFile(files.find((f) => f.name === "index.html").path),
          );
          found = true;
        }
        position +=
          46 +
          length +
          bytes.readUInt16LE(position + 30) +
          bytes.readUInt16LE(position + 32);
      }
      assert.ok(found, "Website ZIP must contain the exact checked HTML");
    }
    if (file.name.endsWith(".mp4")) {
      const { stdout } = await promisify(execFile)("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
        file.path,
      ]);
      const probe = JSON.parse(stdout);
      assert.equal(probe.streams[0].width, 1080);
      assert.equal(probe.streams[0].height, 1920);
      assert.ok(
        Number(probe.format.duration) >= 12 &&
          Number(probe.format.duration) <= 16,
      );
    }
  }
  console.log(
    `PASS: container ${service}, ${files.length} real files, no provider or signing key`,
  );
}
