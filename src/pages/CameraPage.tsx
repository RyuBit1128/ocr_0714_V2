import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  Alert,
  CircularProgress,
  Stack,
} from '@mui/material';
import { CameraAlt, Upload, CloudUpload, TableChart, OpenInNew } from '@mui/icons-material';
import { useAppStore } from '@/stores/appStore';

const CameraPage: React.FC = () => {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  
  const { setCapturedImage, setCurrentStep } = useAppStore();

  // ファイルアップロード（複数枚対応）
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const imageDataArray: string[] = [];
    let processedCount = 0;

    // 各ファイルを処理
    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // 画像ファイルかチェック
      if (!file.type.startsWith('image/')) {
        setCameraError('画像ファイルを選択してください（JPG、PNG、GIF）');
        return;
      }

      // ファイルサイズチェック（10MB以下）
      if (file.size > 10 * 1024 * 1024) {
        setCameraError('ファイルサイズは10MB以下にしてください');
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        if (result) {
          imageDataArray.push(result);
        }
        processedCount++;

        // すべてのファイルが読み込まれたら処理開始
        if (processedCount === files.length) {
          processImages(imageDataArray);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  // 画像処理（複数枚対応）
  const processImages = (imageDataArray: string[]) => {
    setIsCapturing(true);
    setCapturedImage(imageDataArray);
    setCurrentStep(2);

    // 少し遅延を入れてから次のページに遷移
    setTimeout(() => {
      navigate('/processing');
    }, 500);
  };

  // ファイル選択ダイアログを開く
  const openFileDialog = () => {
    fileInputRef.current?.click();
  };

  // スプレッドシートを開く
  const openSpreadsheet = () => {
    const spreadsheetId = import.meta.env.VITE_SPREADSHEET_ID;
    if (spreadsheetId) {
      const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
      window.open(spreadsheetUrl, '_blank', 'noopener,noreferrer');
    } else {
      setCameraError('スプレッドシートIDが設定されていません');
    }
  };

  return (
    <Box sx={{ textAlign: 'center' }}>
      <Typography variant="h5" gutterBottom sx={{ mb: 3, fontWeight: 600 }}>
        作業記録簿を読み取り
      </Typography>

      {cameraError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {cameraError}
        </Alert>
      )}

      {/* 隠しファイル入力（複数枚選択対応） */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileUpload}
        multiple
        style={{ display: 'none' }}
      />

      {/* アクションボタン */}
      <Stack spacing={2} sx={{ mb: 3 }}>
        <Button
          variant="contained"
          size="large"
          onClick={openFileDialog}
          disabled={isCapturing}
          startIcon={isCapturing ? <CircularProgress size={24} /> : <CloudUpload />}
          sx={{ 
            minWidth: '200px',
          }}
        >
          {isCapturing ? '処理中...' : '📁 ファイルを選択 / 撮影する'}
        </Button>

        <Button
          variant="outlined"
          size="large"
          onClick={openSpreadsheet}
          startIcon={<TableChart />}
          endIcon={<OpenInNew />}
          sx={{ 
            minWidth: '200px',
            borderColor: 'success.main',
            color: 'success.main',
            '&:hover': {
              borderColor: 'success.dark',
              backgroundColor: 'success.light',
              color: 'success.dark',
            },
          }}
        >
          📊 スプレッドシートを開く
        </Button>
      </Stack>

      {/* 使用方法の説明 */}
      <Card sx={{ textAlign: 'left' }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center' }}>
            <CameraAlt sx={{ mr: 1 }} /> 使用方法
          </Typography>
          <Typography variant="body1" component="ul" sx={{ pl: 2, mb: 2 }}>
            <li>📝 作業記録簿全体が画面に収まるようにしてください</li>
            <li>💡 明るい場所で撮影してください</li>
            <li>📐 記録簿が水平になるように調整してください</li>
            <li>🚫 影や反射を避けてください</li>
          </Typography>
          
          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', mt: 2 }}>
            <Upload sx={{ mr: 1 }} /> ファイルアップロード
          </Typography>
          <Typography variant="body1" component="ul" sx={{ pl: 2, mb: 2 }}>
            <li>📁 JPG、PNG、GIFファイルに対応</li>
            <li>📏 ファイルサイズは10MB以下</li>
            <li>🖼️ 既に撮影済みの画像を使用できます</li>
          </Typography>

          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', mt: 2 }}>
            <TableChart sx={{ mr: 1 }} /> スプレッドシート
          </Typography>
          <Typography variant="body1" component="ul" sx={{ pl: 2, mb: 0 }}>
            <li>📊 保存されたデータを確認できます</li>
            <li>✏️ 手動でデータを編集・追加できます</li>
            <li>📈 集計やグラフ作成も可能です</li>
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
};

export default CameraPage;