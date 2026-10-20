from datetime import date
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "Prediction_Rules_and_Formulas.xlsx"


def col_name(index: int) -> str:
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def cell(ref: str, value, style: int = 0, formula: bool = False) -> str:
    if value is None or value == "":
        return f'<c r="{ref}" s="{style}"/>'
    if formula:
        return f'<c r="{ref}" s="{style}"><f>{escape(str(value))}</f></c>'
    if isinstance(value, (int, float)):
        return f'<c r="{ref}" s="{style}"><v>{value}</v></c>'
    return f'<c r="{ref}" s="{style}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>'


def sheet_xml(rows, widths=None, freeze=None):
    cols = ""
    if widths:
        cols = "<cols>" + "".join(
            f'<col min="{index}" max="{index}" width="{width}" customWidth="1"/>'
            for index, width in enumerate(widths, 1)
        ) + "</cols>"
    sheet_data = []
    for row_num, entries in enumerate(rows, 1):
        cells = []
        for col_num, entry in enumerate(entries, 1):
            if isinstance(entry, tuple):
                value, style, formula = entry
            else:
                value, style, formula = entry, 0, False
            cells.append(cell(f"{col_name(col_num)}{row_num}", value, style, formula))
        sheet_data.append(f'<row r="{row_num}">{"".join(cells)}</row>')
    pane = f'<sheetViews><sheetView workbookViewId="0"><pane ySplit="{freeze}" topLeftCell="A{freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' if freeze else ""
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{pane}{cols}<sheetData>{"".join(sheet_data)}</sheetData></worksheet>'


title = ("Prediction Rules & Formulas", 1, False)
heading = ("", 2, False)

readme = [
    [title],
    [("Purpose", 2, False), ("Documents the current prototype rule-based prediction logic used by the ZESA Wind Turbine Monitoring System.", 0, False)],
    [("Model", 2, False), ("seasonal-baseline-0.1 — fixed seasonal formula; it is not a trained machine-learning or AI model.", 0, False)],
    [("Source files", 2, False), ("backend/app/main.py and frontend/src/prediction-workspace.ts", 0, False)],
    [("Forecast limit", 2, False), ("The API returns a maximum of 180 days.", 0, False)],
    [("Validation", 2, False), ("Displayed back-test MAE is 1.42 m/s. This value is configured in code, not calculated during each request.", 0, False)],
    [("Important", 2, False), ("Risk, health, RUL, availability and revenue are deterministic business rules. Validate against SCADA and field evidence before operational decisions.", 0, False)],
    [("Workbook guide", 2, False), ("Rule Catalogue lists each formula. Worked Example contains editable input cells and Excel calculations that mirror the key rules.", 0, False)],
]

catalogue = [
    [("Rule Catalogue", 1, False)],
    [("Area", 2, False), ("Output", 2, False), ("Formula / Rule", 2, False), ("Inputs", 2, False), ("Type", 2, False), ("Notes", 2, False)],
    ["Backend forecast", "Seasonal wind speed", "7.5 + 1.7 × SIN(day / 30 × 6.28)", "Forecast day index (0–179)", "Calculated forecast", "Fixed 30-day sinusoidal seasonal cycle."],
    ["Backend forecast", "Baseline power output (kW)", "2100 × ((wind_speed − 2.5) / 10)^1.8", "Seasonal wind speed", "Calculated forecast", "Simplified power curve; no explicit cut-in/cut-out guard beyond the generated baseline range."],
    ["Backend forecast", "Lower wind bound", "wind_speed − 1.6", "Seasonal wind speed", "Calculated forecast", "Fixed uncertainty band."],
    ["Backend forecast", "Upper wind bound", "wind_speed + 1.6", "Seasonal wind speed", "Calculated forecast", "Fixed uncertainty band."],
    ["Asset scope", "Capacity share", "asset_capacity_kw / fleet_capacity_kw", "Selected asset capacity; fleet total capacity", "Calculated adjustment", "Applied only when an individual turbine is selected."],
    ["Asset scope", "Operating factor", "(0.84 + (asset_id MOD 5) × 0.035) × IF(status = maintenance, 0.72, 1)", "Asset ID; status", "Rule-based adjustment", "Creates deterministic per-turbine variation."],
    ["Asset scope", "Wind bias", "((asset_id MOD 5) − 2) × 0.18", "Asset ID", "Rule-based adjustment", "A fixed turbine-specific wind offset."],
    ["Asset scope", "Adjusted wind", "MAX(2.5, baseline_wind + wind_bias + SIN(row_index / 8 + asset_id) × 0.22)", "Baseline wind; asset ID; forecast row index", "Calculated adjustment", "Minimum displayed wind is 2.5 m/s."],
    ["Asset scope", "Adjusted power", "baseline_power × capacity_share × operating_factor × (adjusted_wind / MAX(baseline_wind, 0.1))^1.5", "Baseline power/wind; adjusted wind; capacity share; operating factor", "Calculated adjustment", "Produces the selected-turbine energy series."],
    ["Asset scope", "Adjusted lower bound", "MAX(0, baseline_lower + wind_bias)", "Baseline lower bound; wind bias", "Calculated adjustment", "Cannot be negative."],
    ["Asset scope", "Adjusted upper bound", "baseline_upper + wind_bias", "Baseline upper bound; wind bias", "Calculated adjustment", "No upper cap."],
    ["Condition rules", "Failure risk (%)", "CLAMP(18 + ((asset_id × 13) MOD 57) + IF(status = maintenance, 16, 0) + ROUND((6.4 − average_wind) × 4), 0, 100)", "Asset ID; status; forecast-window average wind", "Rule-based estimate", "Not a trained failure-probability model."],
    ["Condition rules", "Health score", "CLAMP(108 − failure_risk, 0, 100)", "Failure risk", "Rule-based estimate", "Inverse mapping from rule-based risk."],
    ["Condition rules", "Remaining useful life", "MAX(21, 230 − failure_risk × 2)", "Failure risk", "Rule-based estimate", "Days; minimum is 21."],
    ["Availability", "Forecast availability (%)", "CLAMP((IF(asset selected, 99.2 − (100 − health) × 0.13, 97.2) − (6.5 − average_wind) × 0.7 − horizon_days / 720), 0, 100)", "Asset selection; health; average wind; horizon", "Rule-based estimate", "Fleet uses 97.2 as its starting value."],
    ["Commercial", "Forecast revenue", "forecast_energy_mwh × 82", "Forecast energy", "Calculated estimate", "Fixed tariff assumption: USD 82/MWh."],
    ["Commercial", "Revenue at risk", "forecast_revenue × 0.14", "Forecast revenue", "Calculated estimate", "Used in the revenue detail card."],
    ["Display", "Confidence (%)", "MAX(52, 68 − ROUND(horizon_days / 36))", "Forecast horizon", "Rule-based display", "A planning-confidence indicator, not statistical confidence."],
    ["Display", "High-risk count", "COUNT(asset_failure_risk ≥ 55)", "Rule-based risk across scoped assets", "Calculated count", "Shown in the risk KPI."],
]

example = [
    [("Worked Example — Edit blue input cells", 1, False)],
    [("Input / calculation", 2, False), ("Value", 2, False), ("Unit / explanation", 2, False)],
    [("Forecast day index", 2, False), 12, "Input: 0–179"],
    [("Asset ID", 2, False), 7, "Input"],
    [("Asset capacity", 2, False), 3000, "kW — input"],
    [("Fleet capacity", 2, False), 36000, "kW — input"],
    [("Asset status", 2, False), "operational", "Use operational or maintenance"],
    [("Forecast horizon", 2, False), 90, "days — input"],
    [("Baseline wind speed", 2, False), ("7.5+1.7*SIN(B3/30*6.28)", 3, True), "m/s"],
    [("Baseline power", 2, False), ("2100*((B9-2.5)/10)^1.8", 3, True), "kW"],
    [("Lower wind bound", 2, False), ("B9-1.6", 3, True), "m/s"],
    [("Upper wind bound", 2, False), ("B9+1.6", 3, True), "m/s"],
    [("Capacity share", 2, False), ("B5/B6", 3, True), "asset capacity / fleet capacity"],
    [("Operating factor", 2, False), ("(0.84+MOD(B4,5)*0.035)*IF(B7=\"maintenance\",0.72,1)", 3, True), "deterministic asset factor"],
    [("Wind bias", 2, False), ("(MOD(B4,5)-2)*0.18", 3, True), "m/s"],
    [("Adjusted wind", 2, False), ("MAX(2.5,B9+B15+SIN(B3/8+B4)*0.22)", 3, True), "m/s"],
    [("Adjusted power", 2, False), ("B10*B13*B14*(B16/MAX(B9,0.1))^1.5", 3, True), "kW"],
    [("Average wind (window)", 2, False), ("B16", 3, True), "Use the average forecast-window wind in production"],
    [("Failure risk", 2, False), ("MAX(0,MIN(100,18+MOD(B4*13,57)+IF(B7=\"maintenance\",16,0)+ROUND((6.4-B18)*4,0)))", 3, True), "%"],
    [("Health score", 2, False), ("MAX(0,MIN(100,108-B19))", 3, True), "/100"],
    [("Remaining useful life", 2, False), ("MAX(21,230-B19*2)", 3, True), "days"],
    [("Forecast availability", 2, False), ("MAX(0,MIN(100,(99.2-(100-B20)*0.13)-(6.5-B18)*0.7-B8/720))", 3, True), "% — selected turbine case"],
    [("Forecast energy example", 2, False), ("B17*B8*24/1000", 3, True), "MWh — illustrative conversion from kW over the selected horizon"],
    [("Forecast revenue", 2, False), ("B23*82", 3, True), "USD at fixed USD 82/MWh tariff"],
    [("Planning confidence", 2, False), ("MAX(52,68-ROUND(B8/36,0))", 3, True), "% — display rule, not statistical confidence"],
]

styles = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="10"/><name val="Aptos"/></font><font><b/><sz val="15"/><color rgb="FFFFFFFF"/><name val="Aptos Display"/></font><font><b/><sz val="10"/><color rgb="FF0B4675"/><name val="Aptos"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF087FC3"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDF2FF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0"/><xf numFmtId="0" fontId="2" fillId="3" borderId="0"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0"/></cellXfs></styleSheet>'''

with ZipFile(OUT, "w", ZIP_DEFLATED) as workbook:
    workbook.writestr("[Content_Types].xml", '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>''')
    workbook.writestr("_rels/.rels", '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>''')
    workbook.writestr("xl/workbook.xml", '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Read Me" sheetId="1" r:id="rId1"/><sheet name="Rule Catalogue" sheetId="2" r:id="rId2"/><sheet name="Worked Example" sheetId="3" r:id="rId3"/></sheets><calcPr calcId="0" fullCalcOnLoad="1"/></workbook>''')
    workbook.writestr("xl/_rels/workbook.xml.rels", '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>''')
    workbook.writestr("xl/styles.xml", styles)
    workbook.writestr("xl/worksheets/sheet1.xml", sheet_xml(readme, [24, 105], 1))
    workbook.writestr("xl/worksheets/sheet2.xml", sheet_xml(catalogue, [20, 26, 88, 45, 24, 56], 2))
    workbook.writestr("xl/worksheets/sheet3.xml", sheet_xml(example, [29, 36, 62], 2))

print(OUT)
