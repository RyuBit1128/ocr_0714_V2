import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  LinearProgress,
  Paper,
  CircularProgress,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import { useAppStore } from '@/stores/appStore';
import { OpenAIOcrService } from '@/services/ocrService';
import { DataCorrectionService } from '@/services/dataCorrectionService';
import { GoogleSheetsService } from '@/services/googleSheetsService';
import { log } from '@/utils/logger';

const ProcessingPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    capturedImage,
    setOcrResult,
    setCurrentStep,
    error,
    setError,
    setIsProcessing,
  } = useAppStore();

  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('処理を開始しています...');
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);

  // 画像がない場合はカメラページに戻る
  useEffect(() => {
    if (!capturedImage) {
      log.debug('キャプチャ画像がないためカメラページに戻ります');
      navigate('/camera');
      return;
    }
  }, [capturedImage, navigate]);

  // OCR処理状態を管理
  const [hasProcessed, setHasProcessed] = useState(false);
  const processingRef = useRef(false); // React Strict Mode対応

  // 実際のOCR処理
  useEffect(() => {
    if (!capturedImage) return;
    
    // 既に処理済み、またはエラーがある場合は処理しない
    if (hasProcessed || error || processingRef.current) return;

    const processImage = async () => {
      // React Strict Mode での重複実行を防ぐ
      if (processingRef.current) return;
      processingRef.current = true;
      
      setIsProcessing(true);
      setCurrentStep(2);
      setHasProcessed(true); // 処理開始をマーク
      
      try {
        // プログレスバーとメッセージの更新を受け取るコールバック
        const onProgress = (progressValue: number, message: string) => {
          setProgress(progressValue);
          setStatusMessage(message);
        };

        // 事前認証チェック（認証が必要な場合は自動的にリダイレクト）
        setStatusMessage('認証を確認中...');
        setProgress(5);
        try {
          await GoogleSheetsService.checkAuthentication();
                  } catch (authError) {
            // 認証エラーの場合は自動的にリダイレクトされるため、ここには通常到達しない
            log.debug('認証チェックでリダイレクトが発生');
            return;
          }

        // OpenAI Vision APIでOCR処理（複数枚は並列処理）
        setStatusMessage('画像を分析中...');
        setProgress(10);

        let ocrResults: any[] = [];

        if (Array.isArray(capturedImage)) {
          // 複数画像の場合は並列処理
          log.info(`${capturedImage.length}枚の画像を並列処理開始`);
          const progressPerImage = 75 / capturedImage.length;

          const results = await Promise.all(
            capturedImage.map((image, index) =>
              OpenAIOcrService.processImage(image, (progress, message) => {
                const overallProgress = 10 + (index * progressPerImage) + (progress / 100 * progressPerImage);
                onProgress(overallProgress, `${index + 1}/${capturedImage.length}: ${message}`);
              })
            )
          );
          ocrResults = results;
          log.info('すべての画像の並列処理が完了');
        } else {
          // 単一画像の場合は従来通り
          const result = await OpenAIOcrService.processImage(capturedImage, onProgress);
          ocrResults = [result];
        }

        // データ補正処理
        setStatusMessage('データを補正中...');
        setProgress(95);
        const correctedResults = await Promise.all(
          ocrResults.map(result => DataCorrectionService.correctOcrResult(result))
        );

        // 複数の結果をマージするか、最初の結果を使用
        const correctedResult = correctedResults[0];
        
        // デフォルトの作業日を今日の日付に設定
                  if (!correctedResult.ヘッダー.作業日 || correctedResult.ヘッダー.作業日 === 'undefined') {
            const today = new Date();
            const formattedDate = `${today.getFullYear()}/${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getDate().toString().padStart(2, '0')}`;
            correctedResult.ヘッダー.作業日 = formattedDate;
            log.info('作業日を今日の日付に設定', formattedDate);
          }

        // プログレス完了
        setProgress(100);
        setStatusMessage('処理完了');

        // 結果をストアに保存
        setOcrResult(correctedResult);
        
        // 短い遅延の後に確認画面に遷移
        setTimeout(() => {
          navigate('/confirmation');
        }, 1000);

      } catch (error) {
          log.error('OCR処理エラー:', error);
          
          let errorMessage = '画像の処理中にエラーが発生しました。';
          
          if (error instanceof Error) {
            if (error.message.includes('API')) {
              errorMessage = 'APIエラーが発生しました。しばらく待ってから再試行してください。';
            } else if (error.message.includes('ネットワーク')) {
              errorMessage = 'ネットワークエラーが発生しました。接続を確認してください。';
            } else {
              errorMessage = error.message;
            }
          }
          
          setError({
            type: 'OCR_ERROR',
            message: errorMessage,
            details: error,
          });
          log.debug('エラーダイアログを表示');
          setErrorDialogOpen(true);
      } finally {
        setIsProcessing(false);
        // 処理完了後にフラグをリセット（エラー時の再試行を可能にする）
        processingRef.current = false;
      }
    };

    processImage();
  }, [capturedImage, hasProcessed, error, navigate, setOcrResult, setCurrentStep, setError, setIsProcessing]);

  // エラーが発生したらダイアログを開く
  useEffect(() => {
    if (error) {
      setErrorDialogOpen(true);
    }
  }, [error]);

  // エラーダイアログを閉じる
  const handleCloseErrorDialog = () => {
    setErrorDialogOpen(false);
    setError(null);
    navigate('/camera');
  };

  if (error) {
    return (
      <Box sx={{ textAlign: 'center' }}>
        <Typography variant="h4" gutterBottom sx={{ mb: 3, fontWeight: 600 }}>
          🔍 文字を読み取り中
        </Typography>

        <Paper sx={{ mb: 3 }}>
          <Box sx={{ display: 'flex', justifyContent: 'center', mb: 3 }}>
            <CircularProgress sx={{ fontSize: 60, color: 'primary.main' }} />
          </Box>

          <Typography variant="h6" gutterBottom sx={{ mb: 3 }}>
            処理中にエラーが発生しました
          </Typography>

          <LinearProgress
            variant="determinate"
            value={100}
            color="error"
            sx={{
              height: 8,
              borderRadius: 4,
              mb: 2,
              '& .MuiLinearProgress-bar': {
                borderRadius: 4,
              },
            }}
          />

          <Typography variant="body2" color="text.secondary">
            エラーが発生しました
          </Typography>
        </Paper>

        {/* エラーダイアログ */}
        <Dialog
          open={errorDialogOpen}
          onClose={handleCloseErrorDialog}
          aria-labelledby="error-dialog-title"
          aria-describedby="error-dialog-description"
          maxWidth="sm"
          fullWidth
          disableEscapeKeyDown
        >
          <DialogTitle id="error-dialog-title" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CircularProgress color="error" />
            読み取りエラー
          </DialogTitle>
          <DialogContent>
            <Typography id="error-dialog-description" sx={{ fontSize: '16px' }}>
              {error.message}
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button 
              onClick={handleCloseErrorDialog} 
              color="primary" 
              variant="contained"
              autoFocus
            >
              確認
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    );
  }

  return (
    <Box sx={{ textAlign: 'center' }}>
      <Typography variant="h4" gutterBottom sx={{ mb: 3, fontWeight: 600 }}>
        🔍 文字を読み取り中
      </Typography>

      <Paper sx={{ mb: 3 }}>
        <Box sx={{ display: 'flex', justifyContent: 'center', mb: 3 }}>
          <CircularProgress sx={{ fontSize: 60, color: 'primary.main' }} />
        </Box>

        <Typography variant="h6" gutterBottom sx={{ mb: 3 }}>
          {statusMessage}
        </Typography>

        <LinearProgress
          variant="determinate"
          value={progress}
          sx={{
            height: 8,
            borderRadius: 4,
            mb: 2,
            '& .MuiLinearProgress-bar': {
              borderRadius: 4,
            },
          }}
        />

        <Typography variant="body2" color="text.secondary">
          {progress}% 完了
        </Typography>
      </Paper>

      <Paper>
        <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
          <CircularProgress size={24} />
        </Box>
        <Typography variant="body1">
          ⏳ しばらくお待ちください...
        </Typography>
        <Typography variant="body2" color="text.secondary">
          手書きの文字を認識し、データを整理しています。
        </Typography>
      </Paper>
    </Box>
  );
};

export default ProcessingPage;
