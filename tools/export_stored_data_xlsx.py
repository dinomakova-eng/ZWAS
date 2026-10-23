#!/usr/bin/env python3
"""Export the WTMS runtime JSON snapshot to a single dependency-free XLSX.

The exporter intentionally writes the stored values without running the API's
runtime enrichment. Timestamps remain ISO-8601 text and nested values remain
compact JSON text so the workbook is a faithful, human-openable representation
of ``wind_points.json.gz``.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
INVALID_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def xml_escape(value: object) -> str:
    text = INVALID_XML.sub("", str(value))
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def column_name(index: int) -> str:
    name = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


def cell_xml(row: int, column: int, value: object, style: int = 0) -> str:
    reference = f"{column_name(column)}{row}"
    style_attribute = f' s="{style}"' if style else ""
    if value is None:
        return f'<c r="{reference}"{style_attribute}/>'
    if isinstance(value, bool):
        return f'<c r="{reference}"{style_attribute} t="b"><v>{int(value)}</v></c>'
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and not math.isfinite(value):
            value = str(value)
        else:
            return f'<c r="{reference}"{style_attribute}><v>{value}</v></c>'
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return (
        f'<c r="{reference}"{style_attribute} t="inlineStr">'
        f'<is><t xml:space="preserve">{xml_escape(value)}</t></is></c>'
    )


def row_xml(row_number: int, values: list[object], style: int = 0) -> str:
    cells = "".join(cell_xml(row_number, index, value, style) for index, value in enumerate(values, 1))
    return f'<row r="{row_number}">{cells}</row>'


def worksheet_start(column_widths: list[float] | None = None, freeze_header: bool = True) -> str:
    columns = ""
    if column_widths:
        definitions = "".join(
            f'<col min="{index}" max="{index}" width="{width}" customWidth="1"/>'
            for index, width in enumerate(column_widths, 1)
        )
        columns = f"<cols>{definitions}</cols>"
    views = (
        '<sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
        '</sheetView></sheetViews>'
        if freeze_header
        else '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
    )
    return (
        XML_DECLARATION
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + views
        + '<sheetFormatPr defaultRowHeight="15"/>'
        + columns
        + "<sheetData>"
    )


def worksheet_end(last_row: int, last_column: int, auto_filter: bool = True) -> str:
    filter_xml = (
        f'<autoFilter ref="A1:{column_name(last_column)}{last_row}"/>' if auto_filter and last_row else ""
    )
    return (
        "</sheetData>"
        + filter_xml
        + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        + "</worksheet>"
    )


def write_tabular_sheet(target, headers: list[str], rows, widths: list[float]) -> int:
    target.write(worksheet_start(widths).encode("utf-8"))
    target.write(row_xml(1, headers, style=1).encode("utf-8"))
    count = 1
    for count, values in enumerate(rows, 2):
        target.write(row_xml(count, list(values)).encode("utf-8"))
    target.write(worksheet_end(count, len(headers)).encode("utf-8"))
    return count - 1


def workbook_xml(sheet_names: list[str]) -> str:
    sheets = "".join(
        f'<sheet name="{xml_escape(name)}" sheetId="{index}" r:id="rId{index}"/>'
        for index, name in enumerate(sheet_names, 1)
    )
    return (
        XML_DECLARATION
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>'
        f"<sheets>{sheets}</sheets><calcPr calcId=\"0\"/></workbook>"
    )


def workbook_relationships(sheet_count: int) -> str:
    relationships = "".join(
        f'<Relationship Id="rId{index}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        f'Target="worksheets/sheet{index}.xml"/>'
        for index in range(1, sheet_count + 1)
    )
    relationships += (
        f'<Relationship Id="rId{sheet_count + 1}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
        'Target="styles.xml"/>'
    )
    return (
        XML_DECLARATION
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + relationships
        + "</Relationships>"
    )


def content_types(sheet_count: int) -> str:
    sheet_overrides = "".join(
        f'<Override PartName="/xl/worksheets/sheet{index}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for index in range(1, sheet_count + 1)
    )
    return (
        XML_DECLARATION
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + sheet_overrides
        + '<Override PartName="/xl/styles.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '<Override PartName="/docProps/core.xml" '
        'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/docProps/app.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        "</Types>"
    )


ROOT_RELATIONSHIPS = (
    XML_DECLARATION
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    "</Relationships>"
)


STYLES = (
    XML_DECLARATION
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
    '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    '<fill><patternFill patternType="solid"><fgColor rgb="FF17365D"/><bgColor indexed="64"/></patternFill></fill></fills>'
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>'
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    "</styleSheet>"
)


def export_xlsx(source_path: Path, output_path: Path) -> tuple[int, int]:
    with gzip.open(source_path, "rt", encoding="utf-8") as source:
        dataset = json.load(source)

    stations = dataset["stations"]
    readings = dataset["readings"]
    station_headers = list(stations[0]) if stations else []
    reading_headers = list(readings[0]) if readings else []
    sheet_names = ["README", "Source", "Stations", "Readings", "Data Dictionary"]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output_path, "w", compression=ZIP_DEFLATED, compresslevel=6, allowZip64=True) as workbook:
        workbook.writestr("[Content_Types].xml", content_types(len(sheet_names)))
        workbook.writestr("_rels/.rels", ROOT_RELATIONSHIPS)
        workbook.writestr("xl/workbook.xml", workbook_xml(sheet_names))
        workbook.writestr("xl/_rels/workbook.xml.rels", workbook_relationships(len(sheet_names)))
        workbook.writestr("xl/styles.xml", STYLES)
        workbook.writestr(
            "docProps/core.xml",
            XML_DECLARATION
            + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>WTMS All Stored Data</dc:title>'
            '<dc:creator>Codex</dc:creator><dc:description>Human-openable export of wind_points.json.gz</dc:description>'
            "</cp:coreProperties>",
        )
        workbook.writestr(
            "docProps/app.xml",
            XML_DECLARATION
            + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
            '<Application>WTMS data exporter</Application></Properties>',
        )

        readme_rows = [
            ["Item", "Value"],
            ["Purpose", "Complete human-openable export of the WTMS runtime data snapshot"],
            ["Source file", str(source_path)],
            ["Stored top-level structure", "source (object), stations (array), readings (array)"],
            ["Station rows", len(stations)],
            ["Reading rows", len(readings)],
            ["Value handling", "Values are exported exactly as stored; no runtime calculations or GIS enrichment were applied"],
            ["Timestamps", "Preserved as ISO-8601 text, including the stored +02:00 offset"],
            ["Nested values", "Preserved as compact JSON text inside their cells"],
            ["Workbook sheets", "Source, Stations, Readings, and Data Dictionary"],
        ]
        with workbook.open("xl/worksheets/sheet1.xml", "w") as target:
            write_tabular_sheet(target, readme_rows[0], readme_rows[1:], [30, 110])

        source_rows = [[key, value] for key, value in dataset["source"].items()]
        with workbook.open("xl/worksheets/sheet2.xml", "w") as target:
            write_tabular_sheet(target, ["field", "stored_value"], source_rows, [30, 110])

        station_widths = [12, 22, 18, 26, 24, 30, 30, 14, 14, 55, 16, 55, 38, 18, 12, 24, 26, 30, 30, 16, 18, 28]
        with workbook.open("xl/worksheets/sheet3.xml", "w") as target:
            write_tabular_sheet(
                target,
                station_headers,
                ([station.get(header) for header in station_headers] for station in stations),
                station_widths[: len(station_headers)],
            )

        reading_widths = [14, 30, 15, 17, 17, 18, 16, 14, 18, 16, 18, 24, 23, 25, 20, 23, 20, 22, 28, 42]
        with workbook.open("xl/worksheets/sheet4.xml", "w") as target:
            write_tabular_sheet(
                target,
                reading_headers,
                ([reading.get(header) for header in reading_headers] for reading in readings),
                reading_widths[: len(reading_headers)],
            )

        dictionary_rows = []
        for section, rows, headers in (
            ("source", [dataset["source"]], list(dataset["source"])),
            ("stations", stations, station_headers),
            ("readings", readings, reading_headers),
        ):
            for header in headers:
                present = next((row.get(header) for row in rows if row.get(header) is not None), None)
                stored_type = type(present).__name__ if present is not None else "null"
                example = present
                if isinstance(example, (dict, list)):
                    example = json.dumps(example, ensure_ascii=False, separators=(",", ":"))
                dictionary_rows.append([section, header, stored_type, example])
        with workbook.open("xl/worksheets/sheet5.xml", "w") as target:
            write_tabular_sheet(
                target,
                ["section", "field", "stored_type", "example_stored_value"],
                dictionary_rows,
                [18, 34, 18, 100],
            )

    return len(stations), len(readings)


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=project_root / "backend" / "data" / "wind_points.json.gz",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=project_root / "WTMS_All_Stored_Data.xlsx",
    )
    args = parser.parse_args()
    station_count, reading_count = export_xlsx(args.source, args.output)
    print(f"Exported {station_count} stations and {reading_count} readings to {args.output}")


if __name__ == "__main__":
    main()
