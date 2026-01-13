import * as XLSX from 'xlsx';

export const parseExcelFile = (file: File): Promise<any[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const isCSV = file.name.toLowerCase().endsWith('.csv');

    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        if (!data) {
          reject(new Error("No data read from file"));
          return;
        }
        
        let workbook;
        if (isCSV) {
          // Read CSV as text
          workbook = XLSX.read(data, { type: 'string' });
        } else {
          // Read Excel as binary
          workbook = XLSX.read(data, { type: 'binary' });
        }
        
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet);
        
        resolve(jsonData);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = (error) => reject(error);
    
    // Read CSV as text, Excel as binary
    if (isCSV) {
      reader.readAsText(file);
    } else {
      reader.readAsBinaryString(file);
    }
  });
};

