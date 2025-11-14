import { OcrResult, MasterDataError, MasterDataErrorType } from '@/types';
import { EnvironmentValidator } from '@/utils/envConfig';
import { TokenExpiryService } from './tokenExpiryService';
import { log } from '@/utils/logger';

/**
 * Google Sheets API を使用したデータ管理サービス
 */
export class GoogleSheetsService {
  private static config: any = null;
  private static accessToken: string | null = null;

  /**
   * MasterDataErrorを作成するヘルパー関数
   */
  private static createMasterDataError(
    errorType: MasterDataErrorType,
    message: string,
    status?: number,
    details?: any
  ): MasterDataError {
    const error = new Error(message) as MasterDataError;
    error.errorType = errorType;
    error.status = status;
    error.details = details;

    // エラータイプに応じて再試行可能性とユーザーアクションを設定
    switch (errorType) {
      case 'API_KEY_BLOCKED':
        error.canRetry = false;
        error.userAction = '管理者にお問い合わせください（APIキー設定の問題）';
        break;
      case 'UNAUTHORIZED':
        error.canRetry = true;
        error.userAction = 'ページを更新して再度お試しください';
        break;
      case 'PERMISSION_DENIED':
        error.canRetry = false;
        error.userAction = '管理者にお問い合わせください（スプレッドシート権限の問題）';
        break;
      case 'NOT_FOUND':
        error.canRetry = false;
        error.userAction = '管理者にお問い合わせください（スプレッドシート/シートが見つかりません）';
        break;
      case 'NETWORK_ERROR':
        error.canRetry = true;
        error.userAction = 'インターネット接続を確認してから再度お試しください';
        break;
      case 'INVALID_RESPONSE':
        error.canRetry = true;
        error.userAction = 'しばらく待ってから再度お試しください';
        break;
      case 'EMPTY_DATA':
        error.canRetry = false;
        error.userAction = '管理者にお問い合わせください（マスターデータが設定されていません）';
        break;
      case 'CONFIG_ERROR':
        error.canRetry = false;
        error.userAction = '管理者にお問い合わせください（設定エラー）';
        break;
      default:
        error.canRetry = true;
        error.userAction = 'ページを更新して再度お試しください';
    }

    return error;
  }
  
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
   * デバイス検出
   */
  private static getDeviceType(): string {
    const userAgent = navigator.userAgent;
    
    if (/iPhone/.test(userAgent)) {
      return 'iphone';
    } else if (/iPad/.test(userAgent)) {
      return 'ipad';
    } else if (/Android/.test(userAgent)) {
      return 'android';
    } else {
      return 'desktop';
    }
  }

  /**
   * デバイス別のUser-Agentを取得
   */
  private static getDeviceUserAgent(): string {
    const deviceType = this.getDeviceType();
    
    switch (deviceType) {
      case 'iphone':
        return 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      case 'ipad':
        return 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      case 'android':
        return 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
      default:
        return navigator.userAgent;
    }
  }

  /**
   * Google OAuth認証を開始（すべてのデバイスで新ウィンドウ方式に統一）
   */
  static async authenticate(): Promise<string> {
    try {
      const config = this.getConfig();
      const redirectUri = window.location.origin + '/ocr_0714_V2/';
      const deviceType = this.getDeviceType();

      // OAuth認証URL を構築
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', config.googleClientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/spreadsheets');
      authUrl.searchParams.set('response_type', 'token');
      authUrl.searchParams.set('include_granted_scopes', 'true');
      authUrl.searchParams.set('state', 'auth_redirect_window');
      authUrl.searchParams.set('prompt', 'consent'); // 毎回同意画面を表示（キャッシュを避ける）

      console.log('🔄 認証ウィンドウを開始:', deviceType);

      // 新しいウィンドウで認証を開始
      const authWindow = window.open(authUrl.toString(), 'auth_window', 'width=500,height=600');

      if (!authWindow) {
        throw new Error('ポップアップがブロックされました。ブラウザ設定を確認してください。');
      }

      // 認証ウィンドウから通知を受け取るまで待機
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('認証タイムアウト（30秒以上応答がありません）'));
        }, 30000);

        const handleMessage = (event: MessageEvent) => {
          if (event.origin !== window.location.origin) return;

          if (event.data.type === 'auth_success' && event.data.token) {
            clearTimeout(timeout);
            window.removeEventListener('message', handleMessage);
            console.log('✅ 認証成功');
            resolve(event.data.token);
          }
        };

        window.addEventListener('message', handleMessage);
      });

    } catch (error) {
      throw new Error(`認証エラー: ${error}`);
    }
  }

  /**
   * localStorage からアクセストークンを復元
   */
  private static loadTokenFromStorage(): void {
    try {
      const token = localStorage.getItem('google_access_token');
      const expiresAt = localStorage.getItem('google_token_expires_at');
      
      if (token && expiresAt) {
        const expirationTime = parseInt(expiresAt, 10);
        if (Date.now() < expirationTime) {
          this.accessToken = token;
          console.log('✅ localStorage からトークンを復元しました');
        } else {
          console.log('⏰ 保存されたトークンが期限切れです');
          this.clearStoredToken();
        }
      }
    } catch (error) {
      console.warn('⚠️ localStorage からのトークン復元に失敗:', error);
    }
  }

  /**
   * localStorage にアクセストークンを保存
   */
  private static saveTokenToStorage(token: string, expiresIn: number = 3600): void {
    try {
      const expiresAt = Date.now() + (expiresIn * 1000); // 秒を ms に変換
      localStorage.setItem('google_access_token', token);
      localStorage.setItem('google_token_expires_at', expiresAt.toString());
      console.log('💾 アクセストークンを localStorage に保存しました');
    } catch (error) {
      console.warn('⚠️ localStorage へのトークン保存に失敗:', error);
    }
  }

  /**
   * localStorage からトークンを削除
   */
  private static clearStoredToken(): void {
    try {
      localStorage.removeItem('google_access_token');
      localStorage.removeItem('google_token_expires_at');
      this.accessToken = null;
      console.log('🗑️ 保存されたトークンを削除しました');
    } catch (error) {
      console.warn('⚠️ トークン削除に失敗:', error);
    }
  }

  /**
   * URL ハッシュから認証結果を取得
   */
  static handleAuthRedirect(): boolean {
    try {
      const hash = window.location.hash;
      if (!hash || !hash.includes('access_token=')) {
        return false;
      }

      console.log('🔍 認証リダイレクトを検出:', hash);

      // ハッシュパラメータを解析
      const params = new URLSearchParams(hash.substring(1));
      const accessToken = params.get('access_token');
      const expiresIn = params.get('expires_in');
      const state = params.get('state');

      if (accessToken && (state === 'auth_redirect' || state === 'auth_redirect_pwa' || state === 'auth_redirect_window')) {
        this.accessToken = accessToken;
        const expiresInSeconds = expiresIn ? parseInt(expiresIn, 10) : 3600;
        this.saveTokenToStorage(accessToken, expiresInSeconds);

        // URL からハッシュを削除
        window.history.replaceState(null, '', window.location.pathname + window.location.search);

        log.success('認証成功！トークンを取得しました');

        // 認証成功後にトークン監視を開始/リセット
        TokenExpiryService.resetMonitoring();

        // 親ウィンドウが存在する場合（新ウィンドウからの通知）
        if (window.opener) {
          try {
            window.opener.postMessage({
              type: 'auth_success',
              token: accessToken,
              expiresIn: expiresInSeconds
            }, window.location.origin);
            window.close();
          } catch (error) {
            console.warn('親ウィンドウへの通知に失敗:', error);
          }
        }

        return true;
      }

      return false;
    } catch (error) {
      console.error('❌ 認証リダイレクト処理エラー:', error);
      return false;
    }
  }

  /**
   * アクセストークンの有効性をチェック
   */
  static async validateToken(): Promise<boolean> {
    // まず localStorage から復元を試行
    if (!this.accessToken) {
      this.loadTokenFromStorage();
    }

    if (!this.accessToken) return false;

    try {
      const response = await fetch(
        `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${this.accessToken}`
      );
      
      if (!response.ok) {
        log.debug('トークンが無効のため localStorage から削除');
        this.clearStoredToken();
        return false;
      }
      
      return true;
    } catch (error) {
      log.warn('トークン検証エラー', error);
      this.clearStoredToken();
      return false;
    }
  }

  /**
   * スプレッドシート内の全シート名を取得
   */
  static async getAllSheetNames(): Promise<string[]> {
    if (!this.accessToken) {
      throw new Error('認証が必要です');
    }

    try {
      const response = await this.fetchWithRetry(
        `https://sheets.googleapis.com/v4/spreadsheets/${this.getConfig().spreadsheetId}?key=${this.getConfig().googleApiKey}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`シート一覧取得エラー: ${response.statusText}`);
      }

      const data = await response.json();
      return data.sheets?.map((sheet: any) => sheet.properties.title) || [];
    } catch (error) {
      console.error('シート一覧取得エラー:', error);
      throw error;
    }
  }

  /**
   * 作業日から適切な年月を計算（21日サイクル）
   * 例：6月21日～7月20日 → 6月シート、7月21日～8月20日 → 7月シート
   */
  private static calculatePeriodYearMonth(workDate: Date): { year: number; month: number } {
    const year = workDate.getFullYear();
    const month = workDate.getMonth() + 1; // 0ベースなので+1
    const day = workDate.getDate();

    // 1日〜20日は前月扱い（前月の21日〜当月20日の期間に属する）
    if (day <= 20) {
      if (month === 1) {
        return { year: year - 1, month: 12 };
      } else {
        return { year, month: month - 1 };
      }
    } else {
      // 21日以降は当月扱い（当月21日〜翌月20日の期間に属する）
      return { year, month };
    }
  }

  /**
   * 従業員名と作業日から個人シートを検索
   */
  static async findPersonalSheet(employeeName: string, workDate: string): Promise<string | null> {
    try {
      // 作業日をDateオブジェクトに変換
      const date = new Date(workDate);
      if (isNaN(date.getTime())) {
        throw new Error('無効な日付形式です');
      }

      // 21日サイクルで年月を計算
      const { year, month } = this.calculatePeriodYearMonth(date);
      
      // 期待されるシート名パターン（ゼロ埋め対応）
      const expectedSheetName = `${employeeName}_${year}年${month.toString().padStart(2, '0')}月`;
      
      // 全シート名を取得
      const allSheetNames = await this.getAllSheetNames();
      
      // 完全一致を確認
      if (allSheetNames.includes(expectedSheetName)) {
        log.debug('個人シートが見つかりました', expectedSheetName);
        return expectedSheetName;
      }

      log.debug('個人シートが見つかりません', expectedSheetName);
      log.debug('利用可能なシート数', allSheetNames.filter(name => name.includes(employeeName)).length);
      
      // 個人シートが見つからない場合のエラーメッセージ
      throw new Error(`個人シートがありません。個人シートを作成してください。\n\n必要なシート名: ${expectedSheetName}\n\n作成手順:\n1. Googleスプレッドシートで新しいシートを追加\n2. シート名を「${expectedSheetName}」に設定\n3. 再度お試しください`);
    } catch (error) {
      log.error('個人シート検索エラー', error);
      throw error;
    }
  }

  /**
   * 認証状態をチェック（認証が無効な場合は自動的にリダイレクト）
   */
  static async checkAuthentication(): Promise<void> {
    await this.ensureAuthenticated();
  }

  /**
   * 必要に応じて認証を実行
   */
  private static async ensureAuthenticated(): Promise<void> {
    const isValid = await this.validateToken();
    if (!isValid) {
      // AuthGuardが存在する場合は自動リダイレクトを無効にする
      const hasAuthGuard = document.querySelector('[data-auth-guard]') !== null;
      if (hasAuthGuard) {
        throw new Error('認証が必要です。ログインしてください。');
      }
      
      // AuthGuardがない場合のみ自動リダイレクト（後方互換性）
      console.log('🔄 認証が無効です。Googleログイン画面にリダイレクトします...');
      await this.authenticate();
      // この時点でページがリダイレクトされるため、以下の行には到達しない
    }
  }

  /**
   * マスターデータ（従業員・商品一覧）を取得
   * 管理シートのA2列以降：氏名、B2列以降：商品名から取得（ヘッダー行除外）
   */
  static async getMasterData(): Promise<{
    employees: string[];
    products: string[];
  }> {
    // キャッシュから取得を試行
    const cachedData = await import('./masterDataCache').then(m => m.MasterDataCache.getCachedData());
    if (cachedData) {
      log.debug('マスターデータをキャッシュから取得');
      return cachedData;
    }

    log.process('マスターデータ取得開始（API経由）');
    await this.ensureAuthenticated();
    log.debug('認証確認完了');

    try {
      // 管理シートからA列とB列を取得（ヘッダー行を除外するため2行目から）
      const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${this.getConfig().spreadsheetId}/values/管理!A2:B?key=${this.getConfig().googleApiKey}`;
      log.api('マスターデータAPI呼び出し開始');
      
      const masterDataResponse = await fetch(apiUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
      });

      log.debug('API レスポンス状態', {
        status: masterDataResponse.status,
        ok: masterDataResponse.ok
      });

      if (!masterDataResponse.ok) {
        log.error('API エラーレスポンス', { status: masterDataResponse.status, statusText: masterDataResponse.statusText });
        throw new Error(`マスターデータの取得に失敗しました: ${masterDataResponse.status} ${masterDataResponse.statusText}`);
      }

      const masterData = await masterDataResponse.json();

      if (!masterData.values || masterData.values.length === 0) {
        throw new Error('マスターデータが空です');
      }

      // A列（氏名）とB列（商品名）を分離
      const employees: string[] = [];
      const productSet = new Set<string>();

      masterData.values.forEach((row: string[]) => {
        // A列：氏名
        if (row[0] && row[0].trim()) {
          employees.push(row[0].trim());
        }
        // B列：商品名
        if (row[1] && row[1].trim()) {
          productSet.add(row[1].trim());
        }
      });

      const products = Array.from(productSet);

      const result = { employees, products };

      // キャッシュに保存
      const { MasterDataCache } = await import('./masterDataCache');
      MasterDataCache.setCachedData(result);

      log.success('マスターデータを取得しました', {
        employees: employees.length,
        products: products.length,
      });
      log.debug('従業員データ件数', employees.length);
      log.debug('商品データ件数', products.length);

      return result;

    } catch (error) {
      log.error('マスターデータ取得エラー', error);
      log.debug('エラー詳細', {
        message: error instanceof Error ? error.message : 'Unknown error',
        type: typeof error
      });

      // エラーの種類を判定して適切なMasterDataErrorを投げる
      if (error instanceof Error && error.message.includes('マスターデータの取得に失敗しました')) {
        // API呼び出しエラーの場合、元のエラーメッセージから詳細を判定
        const originalMessage = error.message;
        if (originalMessage.includes('403')) {
          if (error.message.includes('blocked')) {
            throw this.createMasterDataError(
              'API_KEY_BLOCKED',
              'APIキー制限により接続がブロックされています',
              403,
              error
            );
          } else {
            throw this.createMasterDataError(
              'PERMISSION_DENIED',
              'スプレッドシートへのアクセス権限がありません',
              403,
              error
            );
          }
        } else if (originalMessage.includes('401')) {
          throw this.createMasterDataError(
            'UNAUTHORIZED',
            '認証が無効です。再度ログインが必要です',
            401,
            error
          );
        } else if (originalMessage.includes('404')) {
          throw this.createMasterDataError(
            'NOT_FOUND',
            'スプレッドシートまたはシートが見つかりません',
            404,
            error
          );
        } else {
          throw this.createMasterDataError(
            'INVALID_RESPONSE',
            'APIからの応答が不正です',
            undefined,
            error
          );
        }
      } else if (error instanceof Error && error.message.includes('マスターデータが空です')) {
        throw this.createMasterDataError(
          'EMPTY_DATA',
          'マスターデータが設定されていません',
          undefined,
          error
        );
      } else if (error instanceof TypeError && error.message.includes('fetch')) {
        throw this.createMasterDataError(
          'NETWORK_ERROR',
          'ネットワークエラーが発生しました',
          undefined,
          error
        );
      } else {
        throw this.createMasterDataError(
          'CONFIG_ERROR',
          '設定エラーまたは予期しないエラーが発生しました',
          undefined,
          error
        );
      }
    }
  }

  /**
   * 既存データのチェック（個人ごとの判定）
   */
  static async checkExistingData(ocrResult: OcrResult): Promise<{ [workerName: string]: boolean }> {
    await this.ensureAuthenticated();

    try {
      const workDate = this.normalizeDate(ocrResult.ヘッダー.作業日!);
      console.log(`🔍 ${workDate} の既存データをチェック中...`);
      
      // 全作業者のリストを作成
      const allWorkers = [
        ...(ocrResult.包装作業記録 || []).map(record => record.氏名),
        ...(ocrResult.機械操作記録 || []).map(record => record.氏名),
      ].filter(name => name && name.trim());

      console.log(`👥 チェック対象作業者: ${allWorkers.join(', ')}`);

      const existingDataMap: { [workerName: string]: boolean } = {};

      // 各作業者の個人シートに該当日のデータがあるかチェック
      for (const workerName of allWorkers) {
        try {
          const personalSheetName = await this.findPersonalSheet(workerName, ocrResult.ヘッダー.作業日!);
          if (personalSheetName) {
            const hasExistingData = await this.checkWorkerExistingData(personalSheetName, workDate);
            existingDataMap[workerName] = hasExistingData;
            console.log(`📋 ${personalSheetName} - ${workDate}: ${hasExistingData ? '既存データあり' : '新規データ'}`);
          } else {
            console.log(`⚠️ ${workerName} の個人シートが見つかりません`);
            existingDataMap[workerName] = false; // シートがない場合は新規扱い
          }
        } catch (error) {
          console.warn(`⚠️ ${workerName} のデータチェック中にエラー:`, error);
          existingDataMap[workerName] = false; // エラーの場合は新規扱い
        }
      }
      
      console.log(`✅ 既存データチェック完了:`, existingDataMap);
      return existingDataMap;
    } catch (error) {
      console.error('❌ 既存データチェックエラー:', error);
      throw error;
    }
  }

  /**
   * 作業者の既存データをチェック（D,E,F,H,J,K,L,N列の値の有無で判定）
   */
  private static async checkWorkerExistingData(sheetName: string, workDate: string): Promise<boolean> {
    try {
      // まず該当日付の行を探す
      const rowIndex = await this.findExistingRowByDate(sheetName, workDate);
      if (rowIndex <= 0) {
        return false; // 該当日付の行がなければ新規
      }

      // 該当行のD,E,F,H,J,K,L,N列のデータを取得
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${this.getConfig().spreadsheetId}/values/${sheetName}!D${rowIndex}:N${rowIndex}?key=${this.getConfig().googleApiKey}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
          },
        }
      );

      if (!response.ok) {
        console.log(`❌ データ行取得API失敗: ${response.status} ${response.statusText}`);
        return false;
      }

      const data = await response.json();
      const values = data.values?.[0] || [];
      
      // D,E,F,H,J,K,L,N列のインデックス（D=0, E=1, F=2, H=4, J=6, K=7, L=8, N=10）
      const checkColumns = [0, 1, 2, 4, 6, 7, 8, 10]; // D,E,F,H,J,K,L,N列
      
      // いずれかの列に値があるかチェック
      const hasData = checkColumns.some(colIndex => {
        const value = values[colIndex];
        return value && value.toString().trim() !== '';
      });

      console.log(`📊 ${sheetName} 行${rowIndex} データチェック:`, values);
      console.log(`📊 既存データ判定: ${hasData ? 'あり' : 'なし'}`);
      
      return hasData;
    } catch (error) {
      console.error('作業者既存データチェックエラー:', error);
      return false;
    }
  }

  /**
   * 個人シートにデータを保存
   */
  static async saveToPersonalSheets(ocrResult: OcrResult): Promise<{ failedWorkers?: string[] } | void> {
    await this.ensureAuthenticated();

    try {
      // 全作業者のリストを作成
      const allWorkers = [
        ...(ocrResult.包装作業記録 || []).map(record => record.氏名),
        ...(ocrResult.機械操作記録 || []).map(record => record.氏名),
      ].filter(name => name && name.trim());

      log.process('Google Sheetsへの保存開始');
      log.debug('作業日', ocrResult.ヘッダー.作業日);
      log.debug('工場名', ocrResult.ヘッダー.工場名);
      log.debug('商品名', ocrResult.ヘッダー.商品名);
      log.debug('対象作業者数', allWorkers.length);

      // 失敗した作業者を追跡
      const failedWorkers: string[] = [];

      // 各作業者の個人シートに並列保存（高速化）
      log.process('作業者データを並列保存します');
      
      // 全作業者を並列で処理
      const savePromises = allWorkers.map(async (workerName, index) => {
        try {
          log.debug(`${index + 1}/${allWorkers.length}: 作業者データ保存中`);
          await this.saveWorkerData(workerName, ocrResult);
          return { success: true, workerName };
        } catch (error) {
          if (error instanceof Error && error.message.includes('個人シートがありません')) {
            log.warn('個人シートなしのためスキップ', { worker: index + 1 });
            return { success: false, workerName, reason: 'no_sheet' };
          } else {
            log.error('保存エラー', { worker: index + 1, error });
            return { success: false, workerName, error };
          }
        }
      });
      
      // 全ての保存処理を並列実行
      const results = await Promise.allSettled(savePromises);
      
      // 結果を処理
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const saveResult = result.value;
          if (!saveResult.success) {
            if (saveResult.reason === 'no_sheet') {
              failedWorkers.push(saveResult.workerName);
            } else if (saveResult.error) {
              throw saveResult.error;
            }
          }
        } else {
          log.error('保存処理で予期しないエラー', result.reason);
          throw result.reason;
        }
      }
      
      if (failedWorkers.length > 0) {
        log.warn('一部作業者の保存に失敗', { count: failedWorkers.length });
        return { failedWorkers };
      }
      
      log.success('全ての個人シートへの保存が完了しました');

    } catch (error) {
      console.error('❌ 個人シート保存エラー:', error);
      
      // エラーの詳細情報をログ出力
      if (error instanceof Error) {
        console.error('エラー詳細:', {
          message: error.message,
          stack: error.stack,
          name: error.name
        });
      } else {
        console.error('非Errorオブジェクト:', error);
      }
      
      // API制限エラーの場合は明確なメッセージを表示
      if (error instanceof Error) {
        if (error.message.includes('429') || error.message.includes('rate limit') || error.message.includes('quota')) {
          throw new Error('Google APIの利用制限に達しました。少し時間をおいてから再度お試しください。');
        }
        if (error.message.includes('403') && error.message.includes('RESOURCE_EXHAUSTED')) {
          throw new Error('APIの同時実行制限に達しました。少し時間をおいてから再度お試しください。');
        }
        if (error.message.includes('401') || error.message.includes('Unauthorized')) {
          throw new Error('Google認証が無効です。再度ログインしてください。');
        }
        if (error.message.includes('404') || error.message.includes('Not Found')) {
          throw new Error('スプレッドシートまたは個人シートが見つかりません。管理者に確認してください。');
        }
        if (error.message.includes('network') || error.message.includes('fetch')) {
          throw new Error('ネットワークエラーが発生しました。インターネット接続を確認してください。');
        }
        
        // より具体的なエラーメッセージを表示（開発環境では詳細も表示）
        const isDev = import.meta.env.DEV || import.meta.env.VITE_DEV_MODE === 'true';
        const detailMessage = isDev ? `\n\n詳細: ${error.message}` : '';
        throw new Error(`データの保存に失敗しました。しばらく待ってから再度お試しください。${detailMessage}`);
      }
      
      throw new Error('データの保存に失敗しました。しばらく待ってから再度お試しください。');
    }
  }

  /**
   * 個別の作業者データを保存
   */
  private static async saveWorkerData(workerName: string, ocrResult: OcrResult): Promise<void> {
    if (!workerName || !workerName.trim()) return;

    log.debug('作業者データ保存開始');
    log.debug('作業日', ocrResult.ヘッダー.作業日);

    // 作業日から適切な個人シートを検索
    const personalSheetName = await this.findPersonalSheet(workerName, ocrResult.ヘッダー.作業日!);
    
    if (!personalSheetName) {
      log.error('個人シートが見つかりません');
      throw new Error(`${workerName}の個人シートが見つかりません。シート名: {従業員名}_{YYYY}年{MM}月 で作成してください。`);
    }
    
    log.debug('対象シート確定');
    
    // 作業者の包装作業記録を検索
    const packagingRecord = ocrResult.包装作業記録.find(record => record.氏名 === workerName);
    // 作業者の機械操作記録を検索
    const machineRecord = ocrResult.機械操作記録.find(record => record.氏名 === workerName);

    log.debug('包装作業記録', packagingRecord ? 'あり' : 'なし');
    log.debug('機械操作記録', machineRecord ? 'あり' : 'なし');

    if (!packagingRecord && !machineRecord) {
      log.debug('データがないためスキップ');
      return;
    }

    // スプレッドシート構造に従ってデータを保存
    await this.saveToPersonalSheetStructure(personalSheetName, ocrResult, packagingRecord, machineRecord);
    log.debug('作業者データ保存完了');
  }


  /**
   * スプレッドシート構造.mdに従った個人シートへのデータ保存
   */
  private static async saveToPersonalSheetStructure(
    sheetName: string, 
    ocrResult: OcrResult, 
    packagingRecord: any, 
    machineRecord: any
  ): Promise<void> {
    try {
      // 作業日を正規化（M/D形式）
      const workDate = this.normalizeDate(ocrResult.ヘッダー.作業日!);
      log.debug('シートへの保存処理開始');
      log.debug('正規化された作業日', workDate);
      
      // 既存データの確認（A列の日付で検索）
      const existingRowIndex = await this.findExistingRowByDate(sheetName, workDate);
      log.debug('既存データ検索結果', existingRowIndex > 0 ? '既存行発見' : '新規データ');
      
      // データ作成と保存
      let rowData: (string | number)[];
      
      if (existingRowIndex > 0) {
        // 既存行の場合：既存データと新規データを統合
        rowData = await this.createMergedRowData(sheetName, existingRowIndex, ocrResult, packagingRecord, machineRecord, workDate);
        await this.updatePersonalSheetRow(sheetName, existingRowIndex, rowData);
        log.debug('既存行を更新');
      } else {
        // 新規行の場合：新規データを作成
        rowData = this.createNewRowData(ocrResult, packagingRecord, machineRecord, workDate);
        await this.appendPersonalSheetRow(sheetName, rowData);
        log.debug('新規行を追加');
      }
      
      log.debug('シートへの保存完了');
      
    } catch (error) {
      log.error('シートへの保存エラー', error);
      throw error;
    }
  }

  /**
   * 日付をM/D形式に正規化
   */
  private static normalizeDate(dateStr: string): string {
    console.log(`📅 日付正規化処理: 入力値 "${dateStr}"`);
    
    // MM/DD形式（0埋めあり）を M/D形式に正規化
    let match = dateStr.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (match) {
      const month = parseInt(match[1], 10);
      const day = parseInt(match[2], 10);
      const normalized = `${month}/${day}`;
      if (normalized !== dateStr) {
        console.log(`✅ MM/DD形式を正規化: "${dateStr}" → "${normalized}"`);
        return normalized;
      } else {
        console.log(`✅ 既にM/D形式: "${dateStr}"`);
        return dateStr;
      }
    }
    
    // YYYY/MM/DD形式の場合
    match = dateStr.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (match) {
      const month = parseInt(match[2], 10);
      const day = parseInt(match[3], 10);
      const normalized = `${month}/${day}`;
      console.log(`✅ YYYY/MM/DD形式から変換: "${dateStr}" → "${normalized}"`);
      return normalized;
    }
    
    // YYYY-MM-DD形式の場合
    match = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      const month = parseInt(match[2], 10);
      const day = parseInt(match[3], 10);
      const normalized = `${month}/${day}`;
      console.log(`✅ YYYY-MM-DD形式から変換: "${dateStr}" → "${normalized}"`);
      return normalized;
    }
    
    // MM/DD/YYYY形式の場合
    match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) {
      const month = parseInt(match[1], 10);
      const day = parseInt(match[2], 10);
      const normalized = `${month}/${day}`;
      console.log(`✅ MM/DD/YYYY形式から変換: "${dateStr}" → "${normalized}"`);
      return normalized;
    }
    
    // その他の形式はそのまま返す
    console.log(`⚠️ 未対応形式のためそのまま返却: "${dateStr}"`);
    return dateStr;
  }

  /**
   * A列の日付で既存行を検索
   */
  private static async findExistingRowByDate(sheetName: string, workDate: string): Promise<number> {
    try {
      log.debug('既存行検索開始');
      
      const response = await this.fetchWithRetry(
        `https://sheets.googleapis.com/v4/spreadsheets/${this.getConfig().spreadsheetId}/values/${sheetName}!A:A?key=${this.getConfig().googleApiKey}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
          },
        }
      );

      if (!response.ok) {
        log.error('A列取得API失敗', { status: response.status });
        return -1;
      }

      const data = await response.json();
      const values = data.values || [];
      log.debug('A列データ取得完了', { rows: values.length });
      
      // デバッグログは性能に影響するため削除（必要時のみ有効化）
      // values.forEach((row: any[], index: number) => {
      //   if (row[0]) {
      //     console.log(`  A${index + 1}: "${row[0]}" ${row[0] === workDate ? '🎯 一致!' : ''}`);
      //   }
      // });
      
      // A列の各セルで日付を検索（完全一致）
      for (let i = 0; i < values.length; i++) {
        const cellValue = values[i][0];
        if (cellValue === workDate) {
          const rowNumber = i + 1;
          log.debug('完全一致で既存行発見', { row: rowNumber });
          return rowNumber;
        }
      }
      
      // 完全一致しない場合、正規化して再検索
      log.debug('完全一致なし。正規化して再検索');
      const normalizedWorkDate = this.normalizeDate(workDate);
      log.debug('検索対象日付も正規化', { from: workDate, to: normalizedWorkDate });
      
      for (let i = 0; i < values.length; i++) {
        const cellValue = values[i][0];
        if (cellValue) {
          const normalizedCellValue = this.normalizeDate(cellValue.toString());
          
          // 両方を正規化して比較
          if (normalizedCellValue === normalizedWorkDate) {
            const rowNumber = i + 1;
            log.debug('正規化後一致で既存行発見', { row: rowNumber });
            return rowNumber;
          }
        }
      }
      
      log.debug('対象日付の既存行は見つかりませんでした');
      return -1;
      
    } catch (error) {
      log.error('既存行検索エラー', error);
      return -1;
    }
  }

  /**
   * 既存行の現在のデータを取得
   */
  private static async getCurrentRowData(sheetName: string, rowIndex: number): Promise<(string | number)[]> {
    try {
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${this.getConfig().spreadsheetId}/values/${sheetName}!A${rowIndex}:P${rowIndex}?key=${this.getConfig().googleApiKey}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
          },
        }
      );

      if (!response.ok) {
        return new Array(16).fill('');
      }

      const data = await response.json();
      const values = data.values?.[0] || [];
      
      // 16列に調整（不足分は空文字で埋める）
      const currentData = new Array(16).fill('');
      for (let i = 0; i < Math.min(values.length, 16); i++) {
        currentData[i] = values[i] || '';
      }
      
      return currentData;
    } catch (error) {
      console.error('既存行データ取得エラー:', error);
      return new Array(16).fill('');
    }
  }

  /**
   * 既存行と新規データを統合した行データを作成
   */
  private static async createMergedRowData(
    sheetName: string,
    existingRowIndex: number,
    ocrResult: OcrResult, 
    packagingRecord: any, 
    machineRecord: any, 
    _workDate: string
  ): Promise<(string | number)[]> {
    // 既存行のデータを取得
    const existingData = await this.getCurrentRowData(sheetName, existingRowIndex);
    console.log(`📋 既存行${existingRowIndex}のデータを取得して統合`);
    
    // ⚠️ A列（日付）は検索専用のため絶対に変更しない
    console.log(`  A列(日付): 既存値 "${existingData[0]}" を保護（変更しません）`);
    
    // C列: 商品名（新しい値がある場合のみ設定）
    if (ocrResult.ヘッダー.商品名) {
      existingData[2] = ocrResult.ヘッダー.商品名;
      console.log(`  C列(商品名): "${ocrResult.ヘッダー.商品名}" を設定`);
    }
    
    if (packagingRecord) {
      // 複数区間がある場合は連続労働時間を計算
      if (packagingRecord.時刻リスト && packagingRecord.時刻リスト.length > 1) {
        const continuousTime = this.calculateContinuousWorkTime(packagingRecord.時刻リスト);
        // D列: 開始時刻
        if (continuousTime.開始時刻) {
          existingData[3] = continuousTime.開始時刻;
          console.log(`  D列(包装開始): "${continuousTime.開始時刻}" を設定（連続労働時間計算）`);
        }
        // E列: 終了時刻
        if (continuousTime.終了時刻) {
          existingData[4] = continuousTime.終了時刻;
          console.log(`  E列(包装終了): "${continuousTime.終了時刻}" を設定（連続労働時間計算）`);
        }
      } else {
        // 単一区間の場合は従来通り
        if (packagingRecord.開始時刻) {
          existingData[3] = packagingRecord.開始時刻;
          console.log(`  D列(包装開始): "${packagingRecord.開始時刻}" を設定`);
        }
        if (packagingRecord.終了時刻) {
          existingData[4] = packagingRecord.終了時刻;
          console.log(`  E列(包装終了): "${packagingRecord.終了時刻}" を設定`);
        }
      }
      
      // F列: 休憩時間
      const restTime = this.calculateRestTime(packagingRecord.休憩);
      if (restTime && restTime !== '0:00') {
        existingData[5] = restTime;
        console.log(`  F列(包装休憩): "${restTime}" を設定`);
      }
      // H列: 生産数（新しい値がある場合のみ設定）
      if (packagingRecord.生産数) {
        existingData[7] = packagingRecord.生産数;
        console.log(`  H列(包装生産数): "${packagingRecord.生産数}" を設定`);
      }
    }
    
    if (machineRecord) {
      // 複数区間がある場合は連続労働時間を計算
      if (machineRecord.時刻リスト && machineRecord.時刻リスト.length > 1) {
        const continuousTime = this.calculateContinuousWorkTime(machineRecord.時刻リスト);
        // J列: 機械開始時刻
        if (continuousTime.開始時刻) {
          existingData[9] = continuousTime.開始時刻;
          console.log(`  J列(機械開始): "${continuousTime.開始時刻}" を設定（連続労働時間計算）`);
        }
        // K列: 機械終了時刻
        if (continuousTime.終了時刻) {
          existingData[10] = continuousTime.終了時刻;
          console.log(`  K列(機械終了): "${continuousTime.終了時刻}" を設定（連続労働時間計算）`);
        }
      } else {
        // 単一区間の場合は従来通り
        if (machineRecord.開始時刻) {
          existingData[9] = machineRecord.開始時刻;
          console.log(`  J列(機械開始): "${machineRecord.開始時刻}" を設定`);
        }
        if (machineRecord.終了時刻) {
          existingData[10] = machineRecord.終了時刻;
          console.log(`  K列(機械終了): "${machineRecord.終了時刻}" を設定`);
        }
      }
      
      // L列: 機械休憩時間
      const restTime = this.calculateRestTime(machineRecord.休憩);
      if (restTime && restTime !== '0:00') {
        existingData[11] = restTime;
        console.log(`  L列(機械休憩): "${restTime}" を設定`);
      }
      // N列: 機械生産数（新しい値がある場合のみ設定）
      if (machineRecord.生産数) {
        existingData[13] = machineRecord.生産数;
        console.log(`  N列(機械生産数): "${machineRecord.生産数}" を設定`);
      }
    }
    
    // P列: 備考（複数区間の情報がある場合のみ設定）
    const remarks = this.createRemarks(packagingRecord, machineRecord);
    if (remarks) {
      existingData[15] = remarks;
      console.log(`  P列(備考): "${remarks}" を設定`);
    }
    
    return existingData;
  }

  /**
   * 新規行データを作成
   */
  private static createNewRowData(
    ocrResult: OcrResult, 
    packagingRecord: any, 
    machineRecord: any, 
    _workDate: string
  ): (string | number)[] {
    console.log(`📋 新規行データを作成`);
    const rowData: (string | number)[] = new Array(16).fill('');
    
    // ⚠️ A列（日付）は検索専用のため設定しない（数式や手動入力を保護）
    console.log(`  A列(日付): 保護のため設定しません（既存の数式/データを維持）`);
    
    // C列: 商品名（値がある場合のみ設定）
    if (ocrResult.ヘッダー.商品名) {
      rowData[2] = ocrResult.ヘッダー.商品名;
      console.log(`  C列(商品名): "${ocrResult.ヘッダー.商品名}" を設定`);
    }
    
    if (packagingRecord) {
      // 複数区間がある場合は連続労働時間を計算
      if (packagingRecord.時刻リスト && packagingRecord.時刻リスト.length > 1) {
        const continuousTime = this.calculateContinuousWorkTime(packagingRecord.時刻リスト);
        // D列: 開始時刻
        if (continuousTime.開始時刻) {
          rowData[3] = continuousTime.開始時刻;
          console.log(`  D列(包装開始): "${continuousTime.開始時刻}" を設定（連続労働時間計算）`);
        }
        // E列: 終了時刻
        if (continuousTime.終了時刻) {
          rowData[4] = continuousTime.終了時刻;
          console.log(`  E列(包装終了): "${continuousTime.終了時刻}" を設定（連続労働時間計算）`);
        }
      } else {
        // 単一区間の場合は従来通り
        if (packagingRecord.開始時刻) {
          rowData[3] = packagingRecord.開始時刻;
          console.log(`  D列(包装開始): "${packagingRecord.開始時刻}" を設定`);
        }
        if (packagingRecord.終了時刻) {
          rowData[4] = packagingRecord.終了時刻;
          console.log(`  E列(包装終了): "${packagingRecord.終了時刻}" を設定`);
        }
      }
      
      // F列: 休憩時間
      const restTime = this.calculateRestTime(packagingRecord.休憩);
      if (restTime && restTime !== '0:00') {
        rowData[5] = restTime;
        console.log(`  F列(包装休憩): "${restTime}" を設定`);
      }
      // H列: 生産数（値がある場合のみ設定）
      if (packagingRecord.生産数) {
        rowData[7] = packagingRecord.生産数;
        console.log(`  H列(包装生産数): "${packagingRecord.生産数}" を設定`);
      }
    }
    
    if (machineRecord) {
      // 複数区間がある場合は連続労働時間を計算
      if (machineRecord.時刻リスト && machineRecord.時刻リスト.length > 1) {
        const continuousTime = this.calculateContinuousWorkTime(machineRecord.時刻リスト);
        // J列: 機械開始時刻
        if (continuousTime.開始時刻) {
          rowData[9] = continuousTime.開始時刻;
          console.log(`  J列(機械開始): "${continuousTime.開始時刻}" を設定（連続労働時間計算）`);
        }
        // K列: 機械終了時刻
        if (continuousTime.終了時刻) {
          rowData[10] = continuousTime.終了時刻;
          console.log(`  K列(機械終了): "${continuousTime.終了時刻}" を設定（連続労働時間計算）`);
        }
      } else {
        // 単一区間の場合は従来通り
        if (machineRecord.開始時刻) {
          rowData[9] = machineRecord.開始時刻;
          console.log(`  J列(機械開始): "${machineRecord.開始時刻}" を設定`);
        }
        if (machineRecord.終了時刻) {
          rowData[10] = machineRecord.終了時刻;
          console.log(`  K列(機械終了): "${machineRecord.終了時刻}" を設定`);
        }
      }
      
      // L列: 機械休憩時間
      const restTime = this.calculateRestTime(machineRecord.休憩);
      if (restTime && restTime !== '0:00') {
        rowData[11] = restTime;
        console.log(`  L列(機械休憩): "${restTime}" を設定`);
      }
      // N列: 機械生産数（値がある場合のみ設定）
      if (machineRecord.生産数) {
        rowData[13] = machineRecord.生産数;
        console.log(`  N列(機械生産数): "${machineRecord.生産数}" を設定`);
      }
    }
    
    // P列: 備考（複数区間の情報がある場合のみ設定）
    const remarks = this.createRemarks(packagingRecord, machineRecord);
    if (remarks) {
      rowData[15] = remarks;
      console.log(`  P列(備考): "${remarks}" を設定`);
    }
    
    return rowData;
  }

  /**
   * 時刻文字列を分数に変換
   */
  private static timeToMinutes(timeStr: string): number {
    if (!timeStr) return 0;
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
  }

  /**
   * 分数を時刻文字列に変換
   */
  private static minutesToTime(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}:${mins.toString().padStart(2, '0')}`;
  }

  /**
   * 複数区間から連続的な労働時間を計算
   */
  private static calculateContinuousWorkTime(timeSlots: any[]): { 開始時刻: string; 終了時刻: string; 間の休憩時間: number } {
    if (!timeSlots || timeSlots.length <= 1) {
      // 単一区間または区間なしの場合はそのまま返す
      const slot = timeSlots?.[0] || { 開始時刻: '', 終了時刻: '' };
      return {
        開始時刻: slot.開始時刻,
        終了時刻: slot.終了時刻,
        間の休憩時間: 0
      };
    }

    // 時刻順にソート
    const sortedSlots = timeSlots
      .filter(slot => slot.開始時刻 && slot.終了時刻)
      .sort((a, b) => this.timeToMinutes(a.開始時刻) - this.timeToMinutes(b.開始時刻));

    if (sortedSlots.length === 0) {
      return { 開始時刻: '', 終了時刻: '', 間の休憩時間: 0 };
    }

    console.log(`📊 複数区間の連続労働時間計算:`);
    console.log(`  包装作業: ${sortedSlots.map(slot => `${slot.開始時刻}-${slot.終了時刻}`).join(', ')}`);

    // 最初の開始時刻
    const startTime = sortedSlots[0].開始時刻;
    
    // 間の休憩時間を計算
    let totalBreakMinutes = 0;
    for (let i = 0; i < sortedSlots.length - 1; i++) {
      const currentEnd = this.timeToMinutes(sortedSlots[i].終了時刻);
      const nextStart = this.timeToMinutes(sortedSlots[i + 1].開始時刻);
      const breakMinutes = nextStart - currentEnd;
      
      if (breakMinutes > 0) {
        totalBreakMinutes += breakMinutes;
        console.log(`  休憩${i + 1}: ${sortedSlots[i].終了時刻}-${sortedSlots[i + 1].開始時刻} = ${breakMinutes}分`);
      }
    }

    // 最後の終了時刻から間の休憩時間を引く
    const lastEndTime = sortedSlots[sortedSlots.length - 1].終了時刻;
    const lastEndMinutes = this.timeToMinutes(lastEndTime);
    const adjustedEndMinutes = lastEndMinutes - totalBreakMinutes;
    const adjustedEndTime = this.minutesToTime(adjustedEndMinutes);

    console.log(`  間の休憩時間合計: ${totalBreakMinutes}分`);
    console.log(`  調整後終了時刻: ${lastEndTime} - ${totalBreakMinutes}分 = ${adjustedEndTime}`);
    console.log(`  スプレッドシート記録: ${startTime}-${adjustedEndTime}`);

    return {
      開始時刻: startTime,
      終了時刻: adjustedEndTime,
      間の休憩時間: totalBreakMinutes
    };
  }

  /**
   * 休憩時間を分数で計算
   */
  private static calculateRestTime(restInfo: any): string {
    if (!restInfo) return '0:00';
    
    let totalMinutes = 0;
    if (restInfo.昼休み) totalMinutes += 45; // 昼休み45分
    if (restInfo.中休み) totalMinutes += 15; // 中休み15分
    
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}:${minutes.toString().padStart(2, '0')}`;
  }

  /**
   * 備考欄を作成（複数区間の場合）
   */
  private static createRemarks(packagingRecord: any, machineRecord: any): string {
    const remarks: string[] = [];
    
    if (packagingRecord?.時刻リスト && packagingRecord.時刻リスト.length > 1) {
      const timeSlots = packagingRecord.時刻リスト.map((slot: any) => 
        `${slot.開始時刻}-${slot.終了時刻}`
      ).join(', ');
      remarks.push(`包装作業: ${timeSlots}`);
    }
    
    if (machineRecord?.時刻リスト && machineRecord.時刻リスト.length > 1) {
      const timeSlots = machineRecord.時刻リスト.map((slot: any) => 
        `${slot.開始時刻}-${slot.終了時刻}`
      ).join(', ');
      remarks.push(`機械操作: ${timeSlots}`);
    }
    
    return remarks.join(' | ');
  }

  /**
   * 個人シートの既存行を更新
   */
  private static async updatePersonalSheetRow(
    sheetName: string, 
    rowIndex: number, 
    rowData: (string | number)[]
  ): Promise<void> {
    console.log(`🔄 行更新処理開始: ${sheetName} 行${rowIndex}`);
    console.log(`⚠️ A列（日付）は保護のため更新対象から除外`);
    
    // バッチ更新用のリクエストを作成（A列、G、I、M、O列をスキップ）
    const requests = [];
    
    // B-F列（インデックス1-5）※A列を除外
    if (rowData.slice(1, 6).some(val => val !== '')) {
      requests.push({
        range: `${sheetName}!B${rowIndex}:F${rowIndex}`,
        values: [rowData.slice(1, 6)]
      });
    }
    
    // H列（インデックス7）
    if (rowData[7] !== '') {
      requests.push({
        range: `${sheetName}!H${rowIndex}`,
        values: [[rowData[7]]]
      });
    }
    
    // J-L列（インデックス9-11）
    if (rowData.slice(9, 12).some(val => val !== '')) {
      requests.push({
        range: `${sheetName}!J${rowIndex}:L${rowIndex}`,
        values: [rowData.slice(9, 12)]
      });
    }
    
    // N列（インデックス13）
    if (rowData[13] !== '') {
      requests.push({
        range: `${sheetName}!N${rowIndex}`,
        values: [[rowData[13]]]
      });
    }
    
    // P列（インデックス15）
    if (rowData[15] !== '') {
      requests.push({
        range: `${sheetName}!P${rowIndex}`,
        values: [[rowData[15]]]
      });
    }
    
    if (requests.length === 0) {
      console.log('⚠️ 更新するデータがありません');
      return;
    }
    
    console.log(`📝 A列を除外して更新: ${requests.length}個のリクエスト`);
    
    // バッチ更新実行
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.getConfig().spreadsheetId}/values:batchUpdate?key=${this.getConfig().googleApiKey}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: requests
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      log.error('行更新API失敗', { status: response.status, statusText: response.statusText });
      throw new Error(`行更新エラー: ${errorData.error?.message || response.statusText}`);
    }
    
    log.debug('行更新API成功（A列保護）');
  }

  /**
   * 個人シートに新規行を追加
   */
  private static async appendPersonalSheetRow(
    sheetName: string, 
    rowData: (string | number)[]
  ): Promise<void> {
    console.log(`➕ 行追加処理開始: ${sheetName}`);
    console.log(`⚠️ A列（日付）は保護のため追加対象から除外`);
    
    // スプレッドシートに送信するデータを準備（A列、G、I、M、O列は後でスキップ）
    const cleanRowData = [...rowData];
    
    // 最初の空行を探すために範囲を指定
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.getConfig().spreadsheetId}/values/${sheetName}!A:A?key=${this.getConfig().googleApiKey}`,
      {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
      }
    );
    
    if (!response.ok) {
      throw new Error('シート情報の取得に失敗しました');
    }
    
    const data = await response.json();
    const nextRow = (data.values?.length || 0) + 1;
    
    // バッチ更新でA列、G、I、M、O列をスキップして追加
    const requests = [];
    
    // B-F列（A列を除外）
    if (cleanRowData.slice(1, 6).some(val => val !== '')) {
      requests.push({
        range: `${sheetName}!B${nextRow}:F${nextRow}`,
        values: [cleanRowData.slice(1, 6)]
      });
    }
    
    // H列
    if (cleanRowData[7] !== '') {
      requests.push({
        range: `${sheetName}!H${nextRow}`,
        values: [[cleanRowData[7]]]
      });
    }
    
    // J-L列
    if (cleanRowData.slice(9, 12).some(val => val !== '')) {
      requests.push({
        range: `${sheetName}!J${nextRow}:L${nextRow}`,
        values: [cleanRowData.slice(9, 12)]
      });
    }
    
    // N列
    if (cleanRowData[13] !== '') {
      requests.push({
        range: `${sheetName}!N${nextRow}`,
        values: [[cleanRowData[13]]]
      });
    }
    
    // P列
    if (cleanRowData[15] !== '') {
      requests.push({
        range: `${sheetName}!P${nextRow}`,
        values: [[cleanRowData[15]]]
      });
    }
    
    console.log(`📝 A列を除外して追加: ${requests.length}個のリクエスト`);
    
    // バッチ更新実行
    const updateResponse = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.getConfig().spreadsheetId}/values:batchUpdate?key=${this.getConfig().googleApiKey}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: requests
        }),
      }
    );

    if (!updateResponse.ok) {
      const errorData = await updateResponse.json().catch(() => ({}));
      log.error('行追加API失敗', { status: updateResponse.status, statusText: updateResponse.statusText });
      throw new Error(`行追加エラー: ${errorData.error?.message || updateResponse.statusText}`);
    }
    
    log.debug('行追加API成功（A列保護）');
  }

  /**
   * Google Sheetsが利用可能かチェック
   */
  static async checkAvailability(): Promise<boolean> {
    try {
      await this.ensureAuthenticated();
      
      const response = await this.fetchWithRetry(
        `https://sheets.googleapis.com/v4/spreadsheets/${this.getConfig().spreadsheetId}?key=${this.getConfig().googleApiKey}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
          },
        }
      );

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * リトライ機能付きのfetch実行（User-Agent付き）
   */
  private static async fetchWithRetry(
    url: string, 
    options: RequestInit, 
    maxRetries: number = 3,
    delay: number = 1000
  ): Promise<Response> {
    // User-Agentヘッダーを追加
    const headers = {
      ...options.headers,
      'User-Agent': this.getDeviceUserAgent(),
    };
    
    const fetchOptions = {
      ...options,
      headers,
    };
    
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        log.debug(`API呼び出し試行 ${attempt}/${maxRetries}`);
        const response = await fetch(url, fetchOptions);
        
        // 429 (Too Many Requests) の場合は待機してリトライ
        if (response.status === 429) {
          if (attempt < maxRetries) {
            const waitTime = delay * Math.pow(2, attempt - 1); // 指数バックオフ
            log.debug(`API制限のため ${waitTime}ms 待機してリトライ`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
        }
        
        // 5xx系エラーの場合もリトライ
        if (response.status >= 500 && response.status < 600) {
          if (attempt < maxRetries) {
            log.debug(`サーバーエラー(${response.status})のため ${delay}ms 待機してリトライ`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
        
        return response;
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown fetch error');
        
        if (attempt < maxRetries) {
          log.debug(`ネットワークエラーのため ${delay}ms 待機してリトライ`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
    }
    
    throw lastError || new Error('Max retries exceeded');
  }
}

// 型定義（リダイレクト方式では Google API ライブラリは不要）