"""Tiny .docx writer (no dependencies): headings, and paragraphs with an optional bold lead-in."""

from __future__ import annotations

import io
import zipfile
from xml.sax.saxutils import escape

_CT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""
_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""
_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def _run(text: str, bold: bool = False, size: int | None = None, color: str | None = None) -> str:
    props = ("<w:b/>" if bold else "") + (f'<w:sz w:val="{size}"/>' if size else "") + \
            (f'<w:color w:val="{color}"/>' if color else "")
    return f'<w:r>{"<w:rPr>" + props + "</w:rPr>" if props else ""}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def build(title: str, blocks: list[tuple]) -> bytes:
    """blocks: ("h", text) | ("p", lead_or_None, text, meta_or_None)"""
    body = [f'<w:p><w:pPr><w:spacing w:after="240"/></w:pPr>{_run(title, True, 36)}</w:p>']
    for b in blocks:
        if b[0] == "h":
            body.append(f'<w:p><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>{_run(b[1], True, 28)}</w:p>')
        else:
            _, lead, text, meta = b
            runs = (_run(lead + "  ", True) if lead else "") + (_run(meta + "  ", False, 18, "808080") if meta else "")
            body.append(f'<w:p><w:pPr><w:spacing w:after="160"/></w:pPr>{runs}{_run(text)}</w:p>')
    doc = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {_NS}><w:body>'
           + "".join(body) + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
           '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", _CT)
        z.writestr("_rels/.rels", _RELS)
        z.writestr("word/document.xml", doc)
    return buf.getvalue()
