import { create } from 'zustand';
import { OcrResult, WorkRecord, AppError } from '@/types';

interface AppState {
  // 撮影状態（複数枚対応）
  capturedImage: string | string[] | null;
  setCapturedImage: (image: string | string[] | null) => void;
  
  // OCR結果
  ocrResult: OcrResult | null;
  setOcrResult: (result: OcrResult | null) => void;
  
  // 編集状態
  editedData: WorkRecord[] | null;
  setEditedData: (data: WorkRecord[] | null) => void;
  
  // 処理状態
  isProcessing: boolean;
  setIsProcessing: (processing: boolean) => void;
  
  // エラー状態
  error: AppError | null;
  setError: (error: AppError | null) => void;
  
  // 成功状態
  success: string | null;
  setSuccess: (success: string | null) => void;
  
  // ナビゲーション状態
  currentStep: number;
  setCurrentStep: (step: number) => void;
  
  // データリセット
  resetData: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  // 初期状態
  capturedImage: null,
  ocrResult: null,
  editedData: null,
  isProcessing: false,
  error: null,
  success: null,
  currentStep: 1,
  
  // アクション
  setCapturedImage: (image) => set({ capturedImage: image }),
  setOcrResult: (result) => set({ ocrResult: result }),
  setEditedData: (data) => set({ editedData: data }),
  setIsProcessing: (processing) => set({ isProcessing: processing }),
  setError: (error) => set({ error: error }),
  setSuccess: (success) => set({ success: success }),
  setCurrentStep: (step) => set({ currentStep: step }),
  
  // データリセット
  resetData: () => set({
    capturedImage: null,
    ocrResult: null,
    editedData: null,
    isProcessing: false,
    error: null,
    success: null,
    currentStep: 1,
  }),
}));