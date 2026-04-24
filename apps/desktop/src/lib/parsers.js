import * as XLSX from "xlsx";
const USN_REGEX = /^[0-9][A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{3}$/;
export function parseDepartmentCounts(input) {
    return input
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
        const [department, rawCount] = line.split(":");
        return {
            department: (department ?? "").trim().toUpperCase(),
            count: Number((rawCount ?? "").trim())
        };
    })
        .filter((item) => item.department.length > 0 && Number.isFinite(item.count) && item.count > 0);
}
export function parseUsnsFromText(input) {
    const unique = new Set();
    for (const line of input.split("\n")) {
        const normalized = line.trim().toUpperCase();
        if (!normalized) {
            continue;
        }
        if (USN_REGEX.test(normalized)) {
            unique.add(normalized);
        }
    }
    return Array.from(unique);
}
export function extractUsnsFromWorkbookBuffer(buffer) {
    const workbook = XLSX.read(buffer, { type: "array" });
    const unique = new Set();
    for (const sheetName of workbook.SheetNames) {
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, {
            header: 1,
            raw: false,
            blankrows: false
        });
        for (const row of rows) {
            for (const value of row) {
                if (value === null || value === undefined) {
                    continue;
                }
                const normalized = String(value).trim().toUpperCase();
                if (USN_REGEX.test(normalized)) {
                    unique.add(normalized);
                }
            }
        }
    }
    return Array.from(unique);
}
