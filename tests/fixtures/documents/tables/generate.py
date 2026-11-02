"""Builds the synthetic table PDFs of this folder and their manifest.json.
Run in a throwaway container: reportlab, pypdfium2, Pillow and DejaVu fonts.
All names, prices and companies are invented."""
import io, json, os
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

HERE = os.path.dirname(os.path.abspath(__file__))
pdfmetrics.registerFont(TTFont("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("DejaVu-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
TEXT = ParagraphStyle("t", fontName="DejaVu", fontSize=9, leading=11)
HEAD = ParagraphStyle("h", fontName="DejaVu-Bold", fontSize=13, leading=16)
cases = []


def pdf(name, story):
    SimpleDocTemplate(os.path.join(HERE, name), pagesize=A4, title=name).build(story)


def cells(rows):
    return [[Paragraph(str(c), TEXT) for c in r] for r in rows]


# 1. An invoice with no lines at all, aligned columns, Czech number format.
invoice = [
    ["Položka", "Množství", "Jednotka", "Cena za jednotku", "Celkem"],
    ["Montáž rozvaděče", "1", "ks", "12 450,00", "12 450,00"],
    ["Kabel CYKY 3x2,5", "120", "m", "38,90", "4 668,00"],
    ["Jistič B16", "8", "ks", "214,50", "1 716,00"],
    ["Revize elektroinstalace", "1", "ks", "3 900,00", "3 900,00"],
]
t = Table(cells(invoice), colWidths=[170, 60, 55, 95, 80])
t.setStyle(TableStyle([("ALIGN", (1, 0), (-1, -1), "RIGHT"), ("FONTNAME", (0, 0), (-1, 0), "DejaVu-Bold")]))
pdf("borderless-invoice.pdf", [Paragraph("Faktura FV-2026-0117", HEAD), Spacer(0, 12), t,
     Spacer(0, 12), Paragraph("Celkem bez DPH: 22 734,00 Kč", TEXT)])
cases.append({"file": "borderless-invoice.pdf", "rows": invoice})

# 2. Bordered table with a merged header and a merged first column.
merged = [
    ["Region", "2025", "", "2026", ""],
    ["", "Q1", "Q2", "Q1", "Q2"],
    ["Morava", "1 120", "1 340", "1 410", "1 505"],
    ["Čechy", "2 870", "2 990", "3 105", "3 260"],
]
t = Table(cells(merged), colWidths=[110, 70, 70, 70, 70])
t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black),
                       ("SPAN", (1, 0), (2, 0)), ("SPAN", (3, 0), (4, 0)), ("SPAN", (0, 0), (0, 1))]))
pdf("merged-header.pdf", [Paragraph("Tržby podle regionů (tis. Kč)", HEAD), Spacer(0, 12), t])
cases.append({"file": "merged-header.pdf", "rows": [merged[2], merged[3]]})

# 3. A long price list across three pages with the header repeated.
items = [["Kód", "Název", "Cena Kč"]] + [[f"P-{1000 + i}", f"Šroub M{4 + i % 8}x{10 + i % 30} pozinkovaný", f"{(i * 37) % 900 + 3},{i % 100:02d}"] for i in range(140)]
t = Table(cells(items), colWidths=[60, 280, 80], repeatRows=1)
t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, 0), 0.8, colors.black)]))
pdf("multipage-pricelist.pdf", [Paragraph("Ceník spojovacího materiálu", HEAD), Spacer(0, 8), t])
cases.append({"file": "multipage-pricelist.pdf", "rows": [items[1], items[60], items[139]]})

# 4. Cells with several lines of text.
notes = [
    ["Bod", "Popis", "Odpovídá"],
    ["1", "Dodávka oken musí proběhnout před zahájením fasádních prací, jinak se posouvá termín kolaudace.", "Jana Nováková"],
    ["2", "Zhotovitel doloží revizní zprávy všech zařízení nejpozději při předání stavby.", "Petr Svoboda"],
]
t = Table(cells(notes), colWidths=[30, 300, 110])
t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.grey), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
pdf("multiline-cells.pdf", [Paragraph("Úkoly z kontrolního dne", HEAD), Spacer(0, 12), t])
cases.append({"file": "multiline-cells.pdf", "rows": notes[1:]})

# 5. The invoice printed and scanned: the same table as a picture only.
import pypdfium2 as pdfium
page = pdfium.PdfDocument(os.path.join(HERE, "borderless-invoice.pdf"))[0]
image = page.render(scale=200 / 72).to_pil().convert("L").rotate(0.7, expand=True, fillcolor=255)
buffer = io.BytesIO()
image.save(buffer, "PDF", resolution=200)
open(os.path.join(HERE, "scanned-invoice.pdf"), "wb").write(buffer.getvalue())
cases.append({"file": "scanned-invoice.pdf", "rows": invoice})

json.dump({"cases": cases}, open(os.path.join(HERE, "manifest.json"), "w"), ensure_ascii=False, indent=1)
print(len(cases), "cases")
