import { OcrResult } from '@/types';
import { EnvironmentValidator } from '@/utils/envConfig';
import { OCR_PROMPT } from '@/prompts/ocrPrompt';
import { log } from '@/utils/logger';

/**
 * OpenAI Vision APIを使用したOCRサービス
 */
export class OpenAIOcrService {
  private static config: any = null;
  
  private static getConfig() {
    if (!this.config) {
      try {
        this.config = EnvironmentValidator.getConfig();
      } catch (error) {
        console.warn('環境設定の読み込みに失敗しました:', error);
        this.config = {
          openaiApiKey: '',
          googleClientId: '',
          googleApiKey: '',
          spreadsheetId: '',
          appName: '作業記録簿OCR',
          appVersion: '1.0.0',
          isDev: false
        };
      }
    }
    return this.config;
  }


  /**
   * 画像を圧縮（ファイルサイズ制限対応）
   */
  private static async compressImage(imageData: string, maxSizeKB: number = 2048): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        
        // 最大サイズを制限（長辺1600px以下）
        const maxDimension = 1600;
        const originalWidth = img.width;
        const originalHeight = img.height;
        
        const calculateDimensions = (w: number, h: number) => {
          if (w > h && w > maxDimension) {
            return { width: maxDimension, height: (h * maxDimension) / w };
          } else if (h > maxDimension) {
            return { width: (w * maxDimension) / h, height: maxDimension };
          }
          return { width: w, height: h };
        };
        
        const { width, height } = calculateDimensions(originalWidth, originalHeight);
        
        canvas.width = width;
        canvas.height = height;
        
        // 高品質でリサイズ
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);
        
        // JPEG品質を調整してファイルサイズを制限（非同期処理でUIブロック回避）
        const compressWithQuality = async (currentQuality: number): Promise<string> => {
          return new Promise(resolve => {
            // requestAnimationFrameでメインスレッドをブロックしないように
            requestAnimationFrame(() => {
              const data = canvas.toDataURL('image/jpeg', currentQuality);
              const maxSize = maxSizeKB * 1024 * 4/3;
              
              if (data.length <= maxSize || currentQuality <= 0.3) {
                resolve(data);
              } else {
                // 次の品質レベルで再帰的に処理
                compressWithQuality(currentQuality - 0.1).then(resolve);
              }
            });
          });
        };
        
        compressWithQuality(0.9).then(resolve);
      };
      img.src = imageData;
    });
  }

  /**
   * 途中で切れたJSONを修復
   */
  private static repairIncompleteJson(jsonString: string): string {
    try {
      // 既に正常なJSONの場合はそのまま返す
      JSON.parse(jsonString);
      return jsonString;
    } catch {
      log.debug('JSONが不完全のため修復を試行');
      
      let repairedJson = jsonString.trim();
      
      // 1. 最後のカンマ後に不完全な要素がある場合は削除
      repairedJson = repairedJson.replace(/,\s*$/, '');
      repairedJson = repairedJson.replace(/,\s*[^}\]]*$/, '');
      
      // 2. 不完全な文字列値を修復
      repairedJson = repairedJson.replace(/"[^"]*$/, '""');
      
      // 3. 開いたオブジェクトや配列を閉じる
      let openBraces = 0;
      let openBrackets = 0;
      let inString = false;
      let escapeNext = false;
      
      for (let i = 0; i < repairedJson.length; i++) {
        const char = repairedJson[i];
        
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        
        if (char === '"') {
          inString = !inString;
          continue;
        }
        
        if (inString) continue;
        
        if (char === '{') openBraces++;
        if (char === '}') openBraces--;
        if (char === '[') openBrackets++;
        if (char === ']') openBrackets--;
      }
      
      // 開いたままの括弧を閉じる
      while (openBrackets > 0) {
        repairedJson += ']';
        openBrackets--;
      }
      while (openBraces > 0) {
        repairedJson += '}';
        openBraces--;
      }
      
      // 修復したJSONが正常かテスト
      try {
        JSON.parse(repairedJson);
        log.debug('JSON修復成功');
        return repairedJson;
      } catch {
        log.warn('JSON修復失敗 - 元のJSONを返します');
        return jsonString;
      }
    }
  }

  /**
   * OpenAI Vision APIでOCR処理を実行
   */
  static async processImage(
    imageData: string,
    onProgress?: (progress: number, message: string) => void
  ): Promise<OcrResult> {
    try {
      onProgress?.(5, '画像を準備中...');
      
      // 画像データの形式を確認・変換
      const processedImageData = imageData.startsWith('data:image/') 
        ? imageData 
        : `data:image/jpeg;base64,${imageData}`;

      // 画像を圧縮
      onProgress?.(15, '画像を最適化中...');
      const compressedImage = await this.compressImage(processedImageData);
      
      onProgress?.(25, 'OpenAI APIに接続中...');
      onProgress?.(35, 'リクエストを送信中...');
      
      // 設定されたモデルを使用
      const requestBody = {
        model: 'gpt-5-mini-2025-08-07', // 設定されたOCRモデルを使用
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: OCR_PROMPT
              },
              {
                type: 'image_url',
                image_url: {
                  url: compressedImage,
                  detail: 'high' // 高解像度解析を有効
                }
              }
            ]
          }
        ],
        max_tokens: 3000, // トークン数を増やしてJSONの途中切断を防止
        temperature: 0.1, // 低い温度で安定した結果を得る
      };

      onProgress?.(45, '手書き文字を解析中...');

      // OpenAI APIへのリクエスト
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.getConfig().openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      onProgress?.(75, 'AIが文字を認識中...');
      onProgress?.(85, 'データを構造化中...');

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `OpenAI API エラー (${response.status}): ${
            errorData.error?.message || response.statusText
          }`
        );
      }

      const data = await response.json();
      
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error('OpenAI APIから無効なレスポンスが返されました');
      }

      const content = data.choices[0].message.content;
      
      onProgress?.(90, 'データを解析中...');

      // JSONレスポンスを解析
      const parseOcrResult = (): OcrResult => {
        try {
          // デバッグ用：実際のレスポンス内容を表示（開発環境のみ）
          log.dev('OpenAI APIレスポンス内容:', content);
          
          // 複数のパターンでJSONブロックを抽出
          let jsonString = content.trim();
          
          // パターン1: ```json...``` ブロック
          const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
          if (jsonBlockMatch) {
            jsonString = jsonBlockMatch[1].trim();
            log.debug('```json ブロック形式で解析');
          }
          // パターン2: ```...``` ブロック（言語指定なし）
          else {
            const codeBlockMatch = content.match(/```\s*([\s\S]*?)\s*```/);
            if (codeBlockMatch) {
              jsonString = codeBlockMatch[1].trim();
              log.debug('```コードブロック形式で解析');
            }
            // パターン3: { で始まる部分を抽出
            else {
              const jsonStartIndex = content.indexOf('{');
              const jsonEndIndex = content.lastIndexOf('}');
              if (jsonStartIndex !== -1 && jsonEndIndex !== -1 && jsonEndIndex > jsonStartIndex) {
                jsonString = content.substring(jsonStartIndex, jsonEndIndex + 1).trim();
                log.debug('JSON部分を直接抽出');
              }
              else {
                log.debug('生のレスポンスをそのまま解析');
              }
            }
          }
          
          // JSONが不完全な場合の修復処理
          jsonString = this.repairIncompleteJson(jsonString);
          
          // デバッグ用：抽出したJSON文字列の最初と最後の文字を確認
          log.debug(`JSON解析前: 長さ=${jsonString.length}, 開始="${jsonString.substring(0, 10)}", 終了="${jsonString.substring(jsonString.length - 10)}"`);
          
          return JSON.parse(jsonString);
        } catch (parseError) {
          log.error('JSON解析エラー', parseError);
          log.debug('レスポンス内容長', content.length);
          
          // エラー詳細を開発環境でのみ表示
          log.dev('解析に失敗したレスポンス（最初の500文字）:', content.substring(0, 500));
          
          throw new Error('OCR結果の解析に失敗しました。画像が不鮮明な可能性があります。');
        }
      };
      
      const ocrResult = parseOcrResult();

      // レスポンス形式の検証
      if (!ocrResult.ヘッダー || !ocrResult.包装作業記録) {
        throw new Error('OCR結果の形式が正しくありません。もう一度撮影してください。');
      }

      onProgress?.(100, '処理完了');

      // 使用量をログ出力
      if (data.usage) {
        log.production('OpenAI API使用量', {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        });
      }

      // OCR結果の詳細ログ出力（開発環境のみ）
      log.success('OCR処理完了');
      log.debug('ヘッダー情報解析完了', {
        hasWorkDate: !!ocrResult.ヘッダー.作業日,
        hasFactory: !!ocrResult.ヘッダー.工場名,
        hasProduct: !!ocrResult.ヘッダー.商品名,
        hasWorkTime: !!ocrResult.ヘッダー.作業時間
      });
      
      // 詳細なOCR結果は開発環境でのみ表示
      log.dev('=== OCR結果詳細 ===');
      log.dev(`作業日: ${ocrResult.ヘッダー.作業日}`);
      log.dev(`工場名: ${ocrResult.ヘッダー.工場名}`);
      log.dev(`商品名: ${ocrResult.ヘッダー.商品名}`);
      log.dev(`作業時間: ${ocrResult.ヘッダー.作業時間}`);
      
      // 包装作業記録の統計情報のみ表示
      log.debug('包装作業記録解析完了', {
        count: ocrResult.包装作業記録?.length || 0
      });
      
      // 詳細は開発環境でのみ表示
      if (ocrResult.包装作業記録 && ocrResult.包装作業記録.length > 0) {
        ocrResult.包装作業記録.forEach((record, index) => {
          log.dev(`包装作業者${index + 1}: ${record.氏名}`);
          log.dev(`  開始: ${record.開始時刻}, 終了: ${record.終了時刻}`);
          log.dev(`  休憩: 昼=${record.休憩.昼休み ? '有' : '無'}, 中=${record.休憩.中休み ? '有' : '無'}`);
          log.dev(`  生産数: ${record.生産数}`);
          if (record.時刻リスト && record.時刻リスト.length > 1) {
            record.時刻リスト.forEach((timeSlot, timeIndex) => {
              log.dev(`  時刻${timeIndex + 1}: ${timeSlot.開始時刻} - ${timeSlot.終了時刻}`);
            });
          }
        });
      }
      
      // 機械操作記録の統計情報のみ表示
      log.debug('機械操作記録解析完了', {
        count: ocrResult.機械操作記録?.length || 0
      });
      
      // 詳細は開発環境でのみ表示
      if (ocrResult.機械操作記録 && ocrResult.機械操作記録.length > 0) {
        ocrResult.機械操作記録.forEach((record, index) => {
          log.dev(`機械操作者${index + 1}: ${record.氏名}`);
          log.dev(`  開始: ${record.開始時刻}, 終了: ${record.終了時刻}`);
          log.dev(`  休憩: 昼=${record.休憩.昼休み ? '有' : '無'}, 中=${record.休憩.中休み ? '有' : '無'}`);
          log.dev(`  生産数: ${record.生産数}`);
          if (record.時刻リスト && record.時刻リスト.length > 1) {
            record.時刻リスト.forEach((timeSlot, timeIndex) => {
              log.dev(`  時刻${timeIndex + 1}: ${timeSlot.開始時刻} - ${timeSlot.終了時刻}`);
            });
          }
        });
      }

      // 補正情報の統計のみ表示
      const productCorrected = !!(ocrResult.ヘッダー as any).originalProductName;
      const nameCorrectionCount = [
        ...(ocrResult.包装作業記録 || []),
        ...(ocrResult.機械操作記録 || [])
      ].filter(record => record.originalName).length;
      
      log.debug('データ補正統計', {
        productCorrected,
        nameCorrectionCount
      });
      
      // 詳細な補正情報は開発環境でのみ表示
      if (productCorrected) {
        log.dev(`商品名補正: ${(ocrResult.ヘッダー as any).originalProductName} → ${ocrResult.ヘッダー.商品名} (${Math.round(((ocrResult.ヘッダー as any).productConfidence || 0) * 100)}%)`);
      }
      
      (ocrResult.包装作業記録 || []).forEach((record, index) => {
        if (record.originalName) {
          log.dev(`包装作業者${index + 1}補正: ${record.originalName} → ${record.氏名} (${Math.round((record.confidence || 0) * 100)}%)`);
        }
      });
      
      (ocrResult.機械操作記録 || []).forEach((record, index) => {
        if (record.originalName) {
          log.dev(`機械操作者${index + 1}補正: ${record.originalName} → ${record.氏名} (${Math.round((record.confidence || 0) * 100)}%)`);
        }
      });

      return ocrResult;

    } catch (error) {
      log.error('OCR処理エラー', error);
      
      // エラータイプに応じたメッセージを返す
      if (error instanceof Error) {
        if (error.message.includes('rate_limit')) {
          throw new Error('API利用制限に達しました。しばらく待ってから再試行してください。');
        }
        if (error.message.includes('insufficient_quota')) {
          throw new Error('API利用枠を超過しました。設定を確認してください。');
        }
        if (error.message.includes('invalid_api_key')) {
          throw new Error('APIキーが無効です。設定を確認してください。');
        }
        if (error.message.includes('network') || error.message.includes('fetch')) {
          throw new Error('ネットワークエラーが発生しました。接続を確認してください。');
        }
        throw error;
      }
      
      throw new Error('OCR処理中に予期しないエラーが発生しました。');
    }
  }

  /**
   * APIキーの有効性をチェック
   */
  static async validateApiKey(): Promise<boolean> {
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${this.getConfig().openaiApiKey}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}