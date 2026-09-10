// SPDX-License-Identifier: Apache-2.0

const MAX_EXPANSION_INPUT_BYTES = 8 * 1024 * 1024;
const SAMPLE_EXPANSION_CAP = 50;

const JSONL_EXTENSIONS = [".jsonl", ".ndjson"];
const DELIMITED_EXTENSIONS = [".csv", ".tsv"];

export type SampleExpansion = {
  files: File[];
  notes: string[];
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExtension(name: string, extensions: string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

function parseDelimited(text: string, delimiter: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;
  let sawField = false;
  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 2; continue; }
        quoted = false; index += 1; continue;
      }
      field += char; index += 1; continue;
    }
    if (char === '"' && field === "") { quoted = true; sawField = true; index += 1; continue; }
    if (char === delimiter) { row.push(field); field = ""; sawField = true; index += 1; continue; }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (sawField || row.some((value) => value !== "")) rows.push(row);
      row = []; field = ""; sawField = false; index += 1; continue;
    }
    field += char; sawField = true; index += 1;
  }
  if (quoted) return null;
  if (sawField || field !== "") { row.push(field); rows.push(row); }
  return rows;
}

function encodeDelimited(rows: string[][], delimiter: string): string {
  const escape = (value: string) =>
    /["\n\r]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
  return rows.map((row) => row.map(escape).join(delimiter)).join("\n");
}

export async function expandSampleFiles(files: File[]): Promise<SampleExpansion> {
  const out: File[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  const emit = (body: string, name: string, type: string, duplicates: { count: number }) => {
    if (seen.has(body)) { duplicates.count += 1; return; }
    seen.add(body);
    out.push(new File([body], name, { type }));
  };

  const passThrough = (file: File, text: string, noteList: string[]): void => {
    if (seen.has(text)) {
      noteList.push(`“${file.name}” is the same file as one already selected, so it was only added once.`);
      return;
    }
    seen.add(text);
    out.push(file);
  };

  for (const file of files) {
    const isJsonl = hasExtension(file.name, JSONL_EXTENSIONS);
    const isJson = hasExtension(file.name, [".json"]);
    const isDelimited = hasExtension(file.name, DELIMITED_EXTENSIONS);
    if (!isJsonl && !isJson && !isDelimited) {
      out.push(file);
      continue;
    }
    if (file.size > MAX_EXPANSION_INPUT_BYTES) {
      out.push(file);
      notes.push(`“${file.name}” is too large to split in the browser, so it was attached whole. If it holds more than one example, the reviewer will say so — split it yourself to avoid that.`);
      continue;
    }

    const text = (await file.text()).replace(/^\uFEFF/, "");
    const base = file.name.replace(/\.(jsonl|ndjson|json|csv|tsv)$/i, "");
    const duplicates = { count: 0 };

    if (isDelimited) {
      const delimiter = file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
      const rows = parseDelimited(text, delimiter);
      if (!rows || rows.length === 0) {
        passThrough(file, text, notes);
        notes.push(`“${file.name}” could not be read as ${delimiter === "\t" ? "TSV" : "CSV"}, so it was attached as-is — the reviewer will report what is wrong with it.`);
        continue;
      }
      const [header, ...dataRows] = rows;
      if (dataRows.length === 0) {
        notes.push(`“${file.name}” has a header row but no examples under it, so nothing was attached from it.`);
        continue;
      }
      if (dataRows.length === 1) { passThrough(file, text, notes); continue; }
      const kept = dataRows.slice(0, SAMPLE_EXPANSION_CAP);
      const extension = delimiter === "\t" ? "tsv" : "csv";
      const mime = delimiter === "\t" ? "text/tab-separated-values" : "text/csv";
      kept.forEach((row, index) => {
        const body = encodeDelimited([header, row], delimiter);
        emit(body, `${base}-${index + 1}.${extension}`, mime, duplicates);
      });
      notes.push(`“${file.name}” held ${dataRows.length} examples and was split into ${kept.length - duplicates.count} separate samples.`);
      if (dataRows.length > kept.length) notes.push(`Only the first ${SAMPLE_EXPANSION_CAP} examples of “${file.name}” were used.`);
      if (duplicates.count) notes.push(`${duplicates.count} identical example${duplicates.count === 1 ? "" : "s"} in “${file.name}” ${duplicates.count === 1 ? "was" : "were"} skipped — samples must differ.`);
      continue;
    }

    if (isJsonl) {
      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      const parsed: Array<{ line: string; index: number }> = [];
      let malformed = 0;
      lines.forEach((line, index) => {
        try {
          const val = JSON.parse(line);
          if (isPlainRecord(val)) parsed.push({ line, index });
          else malformed += 1;
        } catch {
          malformed += 1;
        }
      });
      if (parsed.length === 0) {
        passThrough(file, text, notes);
        notes.push(`“${file.name}” could not be read as JSON Lines, so it was attached as-is.`);
        continue;
      }
      if (parsed.length === 1 && malformed === 0) {
        passThrough(file, text, notes);
        continue;
      }
      const kept = parsed.slice(0, SAMPLE_EXPANSION_CAP);
      kept.forEach(({ line }, index) => {
        emit(line, `${base}-${index + 1}.json`, "application/json", duplicates);
      });
      notes.push(`“${file.name}” held ${parsed.length} examples and was split into ${kept.length - duplicates.count} separate samples.`);
      if (parsed.length > kept.length) notes.push(`Only the first ${SAMPLE_EXPANSION_CAP} examples of “${file.name}” were used.`);
      if (malformed) notes.push(`${malformed} line${malformed === 1 ? "" : "s"} in “${file.name}” could not be parsed as an example object and ${malformed === 1 ? "was" : "were"} skipped.`);
      if (duplicates.count) notes.push(`${duplicates.count} identical example${duplicates.count === 1 ? "" : "s"} in “${file.name}” ${duplicates.count === 1 ? "was" : "were"} skipped — samples must differ.`);
      continue;
    }

    // JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      passThrough(file, text, notes);
      notes.push(`“${file.name}” is not valid JSON, so it was attached as-is.`);
      continue;
    }

    if (isPlainRecord(parsed)) {
      passThrough(file, text, notes);
      continue;
    }

    let records: unknown[] = [];
    if (Array.isArray(parsed)) {
      records = parsed;
    }

    if (records.length === 0) {
      notes.push(`“${file.name}” contains no examples, so nothing was attached from it.`);
      continue;
    }
    if (!records.every(isPlainRecord)) {
      passThrough(file, text, notes);
      notes.push(`“${file.name}” is a list of values rather than example objects, so it was attached whole for the reviewer to judge.`);
      continue;
    }

    const kept = records.slice(0, SAMPLE_EXPANSION_CAP);
    kept.forEach((record, index) => {
      emit(
        JSON.stringify(record),
        kept.length === 1 ? `${base}.json` : `${base}-${index + 1}.json`,
        "application/json",
        duplicates
      );
    });
    if (records.length > 1) {
      notes.push(`“${file.name}” held ${records.length} examples and was split into ${kept.length - duplicates.count} separate samples.`);
    }
    if (records.length > kept.length) notes.push(`Only the first ${SAMPLE_EXPANSION_CAP} examples of “${file.name}” were used.`);
    if (duplicates.count) notes.push(`${duplicates.count} identical example${duplicates.count === 1 ? "" : "s"} in “${file.name}” ${duplicates.count === 1 ? "was" : "were"} skipped — samples must differ.`);
  }
  return { files: out, notes };
}

export function prepareSampleFiles(input: {
  files: File[];
  slotMax: number;
  slotsUsed: number;
}): Promise<SampleExpansion & { error: string | null }> {
  return expandSampleFiles(input.files).then(({ files, notes }) => {
    if (files.length === 0) {
      return { files, notes, error: "Nothing in that selection could be read as an example." };
    }
    const room = Math.max(0, input.slotMax - input.slotsUsed);
    if (room === 0) {
      return {
        files: [],
        notes,
        error: `You already have the maximum of ${input.slotMax} samples. Remove one before adding another.`,
      };
    }
    if (files.length > room) {
      return {
        files: files.slice(0, room),
        notes: [
          ...notes,
          `Only ${room} more sample${room === 1 ? "" : "s"} fit — the maximum is ${input.slotMax}, so the first ${room} of your ${files.length} example${files.length === 1 ? "" : "s"} ${room === 1 ? "was" : "were"} kept.`,
        ],
        error: null,
      };
    }
    return { files, notes, error: null };
  });
}
