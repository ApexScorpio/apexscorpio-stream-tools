import sys
try:
    import pypdf
    reader = pypdf.PdfReader(r'S:\Users\lopes\Documents\Apex\Apex_Scorpio_Brandbook.pdf')
    print(f"Total pages in Brandbook PDF: {len(reader.pages)}")
    for i, page in enumerate(reader.pages):
        print(f"--- PAGE {i+1} ---")
        print(page.extract_text()[:600])
except Exception as e:
    print(f"PyPDF error: {e}")
    try:
        import pdfplumber
        with pdfplumber.open(r'S:\Users\lopes\Documents\Apex\Apex_Scorpio_Brandbook.pdf') as pdf:
            for i, page in enumerate(pdf.pages):
                print(f"--- PAGE {i+1} ---")
                print(page.extract_text()[:600])
    except Exception as e2:
        print(f"pdfplumber error: {e2}")
