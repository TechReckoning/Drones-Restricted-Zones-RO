// Builds the AACR "Evidență proprie a tuturor zborurilor efectuate și a timpilor
// de zbor" (Flight Record) as a .docx from a pilot's stored record data.
//
// The record is fully free text except `type`; hours are entered as "00h00min"
// and the total sums them treating 60 minutes as one hour. Bilingual (RO/EN)
// labels mirror the official template. Nothing here touches the request forms.

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle,
} = require('docx');

// "01h30min" / "2h" / "45min" -> total minutes (unparseable -> 0).
function parseHM(s) {
  const str = String(s == null ? '' : s);
  const h = str.match(/(\d+)\s*h/i);
  const m = str.match(/(\d+)\s*m/i); // matches the digits before "min"
  if (!h && !m) return 0;
  return (h ? parseInt(h[1], 10) : 0) * 60 + (m ? parseInt(m[1], 10) : 0);
}
function fmtHM(mins) {
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}min`;
}

const BORDER = { style: BorderStyle.SINGLE, size: 1, color: '999999' };
const CELL_BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
const S = (text, opts = {}) => new TextRun({ text: String(text == null ? '' : text), bold: !!opts.bold, size: opts.size || 20, color: opts.color });

function valueCell(text, width, opts = {}) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    borders: CELL_BORDERS,
    children: [new Paragraph({ alignment: opts.align || AlignmentType.LEFT, children: [S(text, opts)] })],
  });
}
function bilingualCell(ro, en, width, opts = {}) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    borders: CELL_BORDERS,
    children: [
      new Paragraph({ children: [S(ro, { bold: opts.bold, size: 20 })] }),
      new Paragraph({ children: [S(en, { size: 15, color: '666666' })] }),
    ],
  });
}

function buildFlightRecordDoc(data) {
  const pd = (data && data.pilot) || {};
  const flights = Array.isArray(data && data.flights) ? data.flights : [];
  const fullName = [pd.surname, pd.first_name].filter(Boolean).join(' ');
  const totalMins = flights.reduce((sum, f) => sum + parseHM(f && f.hours), 0);

  const pilotRows = [
    ['Nume Prenume', 'Surname and First Name(s)', fullName],
    ['Adresa', 'Address', pd.address],
    ['Telefon fix', 'Phone', pd.phone_fixed],
    ['Telefon mobil', 'Mobile', pd.phone_mobile],
    ['Data nașterii', 'DOB', pd.dob],
    ['Numărul certificatului de pilot la distanță', 'Pilot Certificate Number', pd.certificate_number],
  ].map(([ro, en, val]) => new TableRow({ children: [bilingualCell(ro, en, 32), valueCell(val, 68)] }));
  const pilotTable = new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: pilotRows });

  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      bilingualCell('Data', 'Date', 16, { bold: true }),
      bilingualCell('Tip', 'Type', 16, { bold: true }),
      bilingualCell('Înregistrare', 'Registration', 16, { bold: true }),
      bilingualCell('Rută', 'Route', 36, { bold: true }),
      bilingualCell('ORE', 'Hours', 16, { bold: true }),
    ],
  });
  const flightRows = flights.map((f) => new TableRow({
    children: [
      valueCell(f && f.date, 16), valueCell(f && f.type, 16), valueCell(f && f.registration, 16),
      valueCell(f && f.route, 36), valueCell(f && f.hours, 16),
    ],
  }));
  const totalRow = new TableRow({
    children: [
      new TableCell({
        columnSpan: 4, borders: CELL_BORDERS,
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [S('Total număr de ore / Total number of hours', { bold: true })] })],
      }),
      valueCell(fmtHM(totalMins), 16, { bold: true }),
    ],
  });
  const flightTable = new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...flightRows, totalRow] });

  return new Document({
    sections: [{
      children: [
        new Paragraph({ children: [S('Evidență proprie a tuturor zborurilor efectuate și a timpilor de zbor', { bold: true, size: 26 })] }),
        new Paragraph({ text: '' }),
        pilotTable,
        new Paragraph({ text: '' }),
        new Paragraph({ children: [S('FLIGHT RECORD / Înregistrare zbor', { bold: true, size: 24 })] }),
        new Paragraph({ text: '' }),
        flightTable,
        new Paragraph({ text: '' }),
        new Paragraph({ children: [S('Semnătura / Signature: .......................................................', { size: 20 })] }),
      ],
    }],
  });
}

async function buildFlightRecordDocx(data) {
  return Packer.toBuffer(buildFlightRecordDoc(data));
}

module.exports = { buildFlightRecordDocx, parseHM, fmtHM };
