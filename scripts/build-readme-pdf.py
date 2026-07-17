from pathlib import Path
import re
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    PageBreak,
)


ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"
OUTPUT = ROOT / "README.pdf"


def esc(text):
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def inline(text):
    text = esc(text)
    return re.sub(r"`([^`]+)`", r"<font name='Courier'>\1</font>", text)


def page_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#667085"))
    canvas.drawString(0.72 * inch, 0.45 * inch, "Signify Creator - Beta 1")
    canvas.drawRightString(7.78 * inch, 0.45 * inch, f"Page {doc.page}")
    canvas.restoreState()


def flush_paragraph(lines, story, styles):
    if not lines:
        return
    story.append(Paragraph(inline(" ".join(lines)), styles["Body"]))
    story.append(Spacer(1, 0.08 * inch))
    lines.clear()


def flush_code(lines, story, styles):
    if not lines:
        return
    code = "<br/>".join(esc(line) if line else "&nbsp;" for line in lines)
    story.append(Paragraph(code, styles["CodeBlock"]))
    story.append(Spacer(1, 0.12 * inch))
    lines.clear()


def parse_table(rows, story, styles):
    data = []
    for row in rows:
        cells = [cell.strip() for cell in row.strip().strip("|").split("|")]
        if len(cells) > 1 and not all(set(cell) <= {"-", ":", " "} for cell in cells):
            data.append([Paragraph(inline(cell), styles["TableCell"]) for cell in cells])
    if not data:
        return
    col_count = len(data[0])
    widths = [6.9 * inch / col_count] * col_count
    table = Table(data, colWidths=widths, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAF4F7")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#101828")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#D8E0EA")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(table)
    story.append(Spacer(1, 0.14 * inch))


def build():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(
        name="Title2",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=26,
        leading=31,
        textColor=colors.HexColor("#0B1830"),
        spaceAfter=12,
    ))
    styles.add(ParagraphStyle(
        name="H2",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=15,
        leading=19,
        textColor=colors.HexColor("#0B1830"),
        spaceBefore=13,
        spaceAfter=7,
        keepWithNext=True,
    ))
    styles.add(ParagraphStyle(
        name="Body",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=9.5,
        leading=14,
        textColor=colors.HexColor("#344054"),
        alignment=TA_LEFT,
    ))
    styles.add(ParagraphStyle(
        name="Bullet2",
        parent=styles["Body"],
        leftIndent=14,
        firstLineIndent=-8,
    ))
    styles.add(ParagraphStyle(
        name="CodeBlock",
        parent=styles["Body"],
        fontName="Courier",
        fontSize=8.2,
        leading=11,
        backColor=colors.HexColor("#F5F7FB"),
        borderColor=colors.HexColor("#D8E0EA"),
        borderWidth=0.5,
        borderPadding=7,
        spaceBefore=3,
    ))
    styles.add(ParagraphStyle(
        name="TableCell",
        parent=styles["Body"],
        fontSize=8.4,
        leading=11,
    ))

    story = []
    paragraph = []
    code = []
    table = []
    in_code = False

    for raw in README.read_text(encoding="utf-8").splitlines():
        line = raw.rstrip()
        if line.startswith("```"):
            if in_code:
                flush_code(code, story, styles)
                in_code = False
            else:
                flush_paragraph(paragraph, story, styles)
                if table:
                    parse_table(table, story, styles)
                    table.clear()
                in_code = True
            continue
        if in_code:
            code.append(line)
            continue
        if line.startswith("|"):
            flush_paragraph(paragraph, story, styles)
            table.append(line)
            continue
        if table:
            parse_table(table, story, styles)
            table.clear()
        if not line:
            flush_paragraph(paragraph, story, styles)
            continue
        if line.startswith("# "):
            flush_paragraph(paragraph, story, styles)
            story.append(Paragraph(inline(line[2:]), styles["Title2"]))
            continue
        if line.startswith("## "):
            flush_paragraph(paragraph, story, styles)
            story.append(Paragraph(inline(line[3:]), styles["H2"]))
            continue
        if line.startswith("- "):
            flush_paragraph(paragraph, story, styles)
            story.append(Paragraph("- " + inline(line[2:]), styles["Bullet2"]))
            continue
        if re.match(r"^\d+\. ", line):
            flush_paragraph(paragraph, story, styles)
            story.append(Paragraph(inline(line), styles["Body"]))
            continue
        paragraph.append(line)

    flush_paragraph(paragraph, story, styles)
    if table:
        parse_table(table, story, styles)

    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=letter,
        rightMargin=0.72 * inch,
        leftMargin=0.72 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.7 * inch,
        title="Signify Creator README",
        author="Signify Creator",
    )
    doc.build(story, onFirstPage=page_footer, onLaterPages=page_footer)
    print(OUTPUT)


if __name__ == "__main__":
    build()
