import React from 'react';
import { Upload, FileSpreadsheet } from 'lucide-react';
import { DEMO_DATA_CSV } from '../constants';

interface FileUploadProps {
  onFileUpload: (file: File) => void;
  onUseDemo: () => void;
}

const FileUpload: React.FC<FileUploadProps> = ({ onFileUpload, onUseDemo }) => {
  
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      onFileUpload(file);
    }
  };

  const createDemoFile = () => {
    const blob = new Blob([DEMO_DATA_CSV], { type: 'text/csv' });
    const file = new File([blob], "demo_slate.csv", { type: "text/csv" });
    onFileUpload(file);
  };

  return (
    <div className="radar-modal-style">
      <div className="radar-title">
         &gt; INITIATE DATA UPLOAD
      </div>
      
      <div style={{ 
          border: '1px dashed rgba(0, 255, 65, 0.3)', 
          padding: '2rem', 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center',
          background: 'rgba(0, 255, 65, 0.05)',
          marginBottom: '1.5rem'
      }}>
        <Upload style={{ width: '48px', height: '48px', color: '#00ff41', marginBottom: '1rem' }} />
        
        <p style={{ fontFamily: "'Courier New', monospace", color: 'rgba(0,255,65,0.8)', textAlign: 'center', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
          UPLOAD SLATE_DATA.XLSX OR .CSV
        </p>

        <label className="action-btn">
          SELECT FILE
          <input 
            type="file" 
            accept=".xlsx, .xls, .csv" 
            style={{ display: 'none' }} 
            onChange={handleFileChange}
          />
        </label>
      </div>

      <div style={{ textAlign: 'center', borderTop: '1px solid rgba(0, 255, 65, 0.2)', paddingTop: '1rem' }}>
          <button 
             onClick={createDemoFile}
             style={{ 
                 background: 'transparent', 
                 border: 'none', 
                 color: 'rgba(255,255,255,0.6)', 
                 fontFamily: "'Courier New', monospace", 
                 fontSize: '0.8rem', 
                 cursor: 'pointer',
                 textDecoration: 'underline' 
             }}
          >
             Or load simulation data (Demo)
          </button>
      </div>
    </div>
  );
};

export default FileUpload;
