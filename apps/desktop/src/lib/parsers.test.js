import { describe, expect, it } from "vitest";
import { extractUsnsFromWorkbookBuffer, parseDepartmentCounts, parseUsnsFromText } from "./parsers";
import * as XLSX from "xlsx";
describe("parseDepartmentCounts", () => {
    it("parses valid dept lines", () => {
        const result = parseDepartmentCounts("CSE:5\nISE:3\nBAD:0");
        expect(result).toEqual([
            { department: "CSE", count: 5 },
            { department: "ISE", count: 3 }
        ]);
    });
});
describe("parseUsnsFromText", () => {
    it("extracts unique valid USNs", () => {
        const result = parseUsnsFromText("4SE22CS001\n4se22cs001\n4SE22IS012\nINVALID");
        expect(result).toEqual(["4SE22CS001", "4SE22IS012"]);
    });
});
describe("extractUsnsFromWorkbookBuffer", () => {
    it("extracts USNs from workbook cells", () => {
        const workbook = XLSX.utils.book_new();
        const sheet = XLSX.utils.aoa_to_sheet([
            ["Name", "USN"],
            ["A", "4SE22CS001"],
            ["B", "4SE22IS010"],
            ["X", "NOT_A_USN"]
        ]);
        XLSX.utils.book_append_sheet(workbook, sheet, "Students");
        const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
        const result = extractUsnsFromWorkbookBuffer(buffer);
        expect(result).toContain("4SE22CS001");
        expect(result).toContain("4SE22IS010");
        expect(result).toHaveLength(2);
    });
});
