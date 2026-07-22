const fs = require('fs');

const pdfPath = 'S:\\Users\\lopes\\Documents\\Apex\\Apex_Scorpio_Brandbook.pdf';

if (fs.existsSync(pdfPath)) {
  const buf = fs.readFileSync(pdfPath);
  const text = buf.toString('latin1');

  // Extract readable text chunks
  const matches = text.match(/[\w\s#.,\-:()/áéíóúãõâêîôûç]{5,100}/gi) || [];
  const cleanLines = Array.from(new Set(matches.map(m => m.trim()))).filter(m => 
    m.includes('Color') || m.includes('Cor') || m.includes('RGB') || m.includes('HEX') || m.includes('Font') || m.includes('#') || m.includes('Apex') || m.includes('Jewel') || m.includes('Scorpion') || m.includes('v7') || m.includes('v1')
  );

  console.log('PDF File Size:', buf.length, 'bytes');
  console.log('Sample extracted lines from Apex_Scorpio_Brandbook.pdf:');
  console.log(cleanLines.slice(0, 35).join('\n'));
} else {
  console.log('PDF file not found at:', pdfPath);
}
