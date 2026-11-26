// Columns padded to their widest cell, headers first, as `org list` prints them.
export const text = (rows: string[][]) => {
    const widths = rows[0]!.map((_, column) =>
        Math.max(...rows.map((row) => (row[column] ?? "").length)),
    );
    return rows
        .map((row) =>
            row
                .map((cell, i) => cell.padEnd(widths[i]!))
                .join("  ")
                .trimEnd(),
        )
        .join("\n");
};
