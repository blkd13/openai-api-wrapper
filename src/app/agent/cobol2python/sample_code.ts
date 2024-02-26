export const SAMPLE_INSERT_COBOL = `
       M520-INSERT-RTN             SECTION.
      *
           MOVE    ZERO            TO  SW-NAYOSE
      * 部店コード・口座番号取得
      *
      *    名寄せマスタからの代表口座取得
      *    ユーザーコード
           MOVE  USER-CD OF WK-WJAA310  TO  USER-CD OF TBL-NAYOSE
      *    名寄せコード
           MOVE  NAYOSE-CD OF WK-WJAA310
                                        TO  NAYOSE-CD OF TBL-NAYOSE
      *    代表口座区分
           MOVE    '1'                  TO  INT-KOZA-NO-DAIHYO-KBN
                                            OF TBL-NAYOSE
      *    口座閉鎖区分
           MOVE  SPACE                  TO  KOUZA-HEISA-KBN
                                            OF TBL-NAYOSE
      *    名寄せマスタ検索（代表口座区分'1'を検索）
           PERFORM M521-NAYOSE-SELECT-RTN
      *
           IF ( SW-NAYOSE  =  1 )
           THEN
               MOVE  BTN OF TBL-NAYOSE
                              TO  BTN-DAIHYO OF TBL-COST
               MOVE  INT-KOZA-NO OF TBL-NAYOSE
                              TO  INT-KOZA-NO-DAIHYO OF TBL-COST
           ELSE
      *        名寄せマスタからの代表口座取得
               MOVE    '2'    TO INT-KOZA-NO-DAIHYO-KBN OF TBL-NAYOSE
      *        名寄せマスタ検索（代表口座区分'2'を検索）
               PERFORM M521-NAYOSE-SELECT-RTN
      *
               IF  ( SW-NAYOSE  =  1 )
               THEN
                 MOVE  BTN OF TBL-NAYOSE
                                   TO  BTN-DAIHYO OF TBL-COST
                 MOVE  INT-KOZA-NO OF TBL-NAYOSE
                                   TO  INT-KOZA-NO-DAIHYO OF TBL-COST
               ELSE
      *          名寄せマスタ更新（代表口座設定）
                 PERFORM  M522-NAYOSE-UPDATE-RTN
                 MOVE  BTN OF TBL-NAYOSE
                                   TO  BTN-DAIHYO OF TBL-COST
                 MOVE  INT-KOZA-NO OF TBL-NAYOSE
                                   TO  INT-KOZA-NO-DAIHYO OF TBL-COST
               END-IF
           END-IF
      *
      *ユーザーコード
           MOVE  USER-CD OF WK-WJAA310  TO  USER-CD OF TBL-COST
      *名寄せコード
           MOVE  NAYOSE-CD OF WK-WJAA310
                                        TO  NAYOSE-CD OF TBL-COST
      *特定口座判定区分１
           MOVE  TOKUKOZA-HANTEI-KBN1 OF WK-WJAA310
                              TO  TOKUKOZA-HANTEI-KBN1 OF TBL-COST
      *国内外国区分
           MOVE  NAIGAI-KBN OF WK-WJAA310
                                        TO  NAIGAI-KBN OF TBL-COST
      *商品区分
           MOVE  SHOHIN-KBN OF WK-WJAA310
                                        TO  SHOHIN-KBN OF TBL-COST
      *銘柄コード
           MOVE  MEG-CD OF WK-WJAA310   TO  MEG-CD OF TBL-COST
      *新旧銘柄区分
           MOVE  SINKYU-KBN OF WK-WJAA310
                                        TO  SINKYU-KBN OF TBL-COST
      *残高数量
           MOVE  SURYO OF WK-WJAA310    TO  ZAN-SURYO OF TBL-COST
      *移動平均単価
           IF ( SYORI-BUNRUI-CD-2 OF WK-WJAA310 = '6' )
           THEN
      *        国内投信の場合
               COMPUTE  WK-HEIKIN-TANKA    =  ( WK-KAI-KIN
                                           /  WK-SURYO )
                                           * KEISAN-KUSU OF WK-WJAA310
           ELSE
      *        国内債券・外国債券の場合
               IF ( SYORI-BUNRUI-CD-2 OF WK-WJAA310 = '2'
                                                   OR '4' )
                 AND ( FACTOR-U OF WK-WJAA310      <> CNS-1 )
               THEN
      *----< 債券数量計算処理 >
                   MOVE  FACTOR-U    OF WK-WJAA310  TO  WK-FACTOR
                   PERFORM  M530-SAIKEN-SURYOU-KEISAN-RTN
                   COMPUTE  WK-HEIKIN-TANKA   =  WK-KAI-KIN
                                              /  WK-MARUME-SURYO
               ELSE
                   COMPUTE  WK-HEIKIN-TANKA   =  WK-KAI-KIN
                                              /  WK-SURYO
               END-IF
           END-IF
      *
           INITIALIZE                       PARM-WJAS005-ARG
           EVALUATE  TRUE
               WHEN  ( SYORI-BUNRUI-CD-2 OF WK-WJAA310 = '2'
                                                      OR '4' )
                   AND ( FACTOR-U OF WK-WJAA310        = CNS-1 )
                   AND ( UKEW-D   OF WK-WJAA310        < '20160101' )
                   MOVE  '2'                TO  MARUME-ICHI
               WHEN  ( SYORI-BUNRUI-CD-2 OF WK-WJAA310 = '2'
                                                      OR '4' )
                   AND ((( FACTOR-U OF WK-WJAA310       = CNS-1 )
                       AND ( UKEW-D   OF WK-WJAA310    >= '20160101' ))
                       OR  ( FACTOR-U OF WK-WJAA310    <> CNS-1 ))
                   MOVE  '4'                TO  MARUME-ICHI
               WHEN  ( SYORI-BUNRUI-CD-2 OF WK-WJAA310 = '5' )
                   AND ( SHOHIN1-CD   OF WK-WJAA310   <> '1' )
                   MOVE  '4'                TO  MARUME-ICHI
               WHEN  OTHER
                   MOVE  '0'                TO  MARUME-ICHI
           END-EVALUATE
           MOVE  '1'                    TO  MARUME-HOHO
           MOVE  WK-HEIKIN-TANKA        TO  MARUME-MAE-SUCHI
      *----< 数値丸め処理 >
           CALL  'WJAS005'          USING  PARM-WJAS005-ARG
           IF  RTN-CD OF PARM-WJAS005-ARG  =  CNS-SUB-RTN-NORMAL
           THEN
      *        切り上げ済み移動平均単価の設定
               MOVE  MARUME-ATO-SUCHI   TO  HEIKIN-TANKA OF TBL-COST
           ELSE
      *        丸め処理のエラーをセット
               MOVE  RTN-CD OF PARM-WJAS005-ARG
                                        TO  RTN-CD OF WK-WJALA310
      *
               MOVE  '4'                TO  SOSAI-KBN OF LNK-TORIHIKI
      *
               PERFORM  M990-ERROR-RTN
           END-IF
      *
      *残高金額
           MOVE  WK-KAI-KIN             TO  ZAN-KIN OF TBL-COST
      *修正区分・修正処理日
           MOVE  SPACE                  TO  UPDATE-KBN OF TBL-COST
                                            UPDATE-YMD OF TBL-COST
      *更新プログラム
           MOVE  CNS-PRG-ID             TO  UPDATE-PROGRAM OF TBL-COST
      *作成タイムスタンプ
           MOVE  WK-SQLDATE             TO  CREATE-TIMESTAMP
                                            OF TBL-COST
      *更新・完了・削除タイムスタンプ・更新端末アドレス・社員コード
           MOVE  SPACE                  TO  UPDATE-TIMESTAMP
                                            OF TBL-COST
                                            DELETE-TIMESTAMP
                                            OF TBL-COST
                                            UPDATE-PC-ADDRESS
                                            OF TBL-COST
                                            UPDATE-SYAIN-NO
                                            OF TBL-COST
      *
      * 取得コストテーブルの挿入
           EXEC SQL
             INSERT INTO COST_BATCH (
                 USER_CD,
                 NAYOSE_CD,
                 TOKUKOZA_HANTEI_KBN1,
                 BTN_DAIHYO,
                 INT_KOZA_NO_DAIHYO,
                 NAIGAI_KBN,
                 SHOHIN_KBN,
                 MEG_CD,
                 SINKYU_KBN,
                 ZAN_SURYO,
                 HEIKIN_TANKA,
                 ZAN_KIN,
                 UPDATE_KBN,
                 UPDATE_YMD,
                 UPDATE_PROGRAM,
                 CREATE_TIMESTAMP,
                 UPDATE_TIMESTAMP,
                 DELETE_TIMESTAMP,
                 UPDATE_PC_ADDRESS,
                 UPDATE_SYAIN_NO
                 )
             VALUES (
                 :TBL-COST.USER-CD,
                 :TBL-COST.NAYOSE-CD,
                 :TBL-COST.TOKUKOZA-HANTEI-KBN1,
                 :TBL-COST.BTN-DAIHYO,
                 :TBL-COST.INT-KOZA-NO-DAIHYO,
                 :TBL-COST.NAIGAI-KBN,
                 :TBL-COST.SHOHIN-KBN,
                 :TBL-COST.MEG-CD,
                 :TBL-COST.SINKYU-KBN,
                 :TBL-COST.ZAN-SURYO,
                 :TBL-COST.HEIKIN-TANKA,
                 :TBL-COST.ZAN-KIN,
                 :TBL-COST.UPDATE-KBN,
                 :TBL-COST.UPDATE-YMD,
                 :TBL-COST.UPDATE-PROGRAM,
                 :TBL-COST.CREATE-TIMESTAMP,
                 :TBL-COST.UPDATE-TIMESTAMP,
                 :TBL-COST.DELETE-TIMESTAMP,
                 :TBL-COST.UPDATE-PC-ADDRESS,
                 :TBL-COST.UPDATE-SYAIN-NO
             )
           END-EXEC
      *
      *    SQLCODEの判定
           IF  ( SQLCODE  =  CNS-ORA-SUCCESS )
           THEN
               MOVE  ZERO               TO  RTN-CD OF WK-WJALA310
      *
      *    更新後情報を取引明細に設定
               MOVE  ZAN-SURYO OF TBL-COST
                                        TO  ZAN-SURYO-GO OF WK-WJAA310
               MOVE  HEIKIN-TANKA OF TBL-COST
                                        TO  HEIKIN-TANKA-GO
                                            OF WK-WJAA310
               MOVE  ZAN-KIN OF TBL-COST
                                        TO  ZAN-KIN-GO OF WK-WJAA310
           ELSE
               MOVE  -1                 TO  RTN-CD OF WK-WJALA310
               MOVE  CNS-SQL-INSERT     TO  ERR-SQL OF WK-WJALA310
               MOVE  CNS-TBL-COST       TO  ERR-TABLE-ID OF WK-WJALA310
               PERFORM  M990-ERROR-RTN
           END-IF
      *
           CONTINUE.
       M520-INSERT-EXT.
           EXIT.
`;

export const SAMPLE_INSERT_PYTHON = `
# M520 取得コストＩＮＳＥＲＴ処理
def m520_insert_rtn():
    # Initialize variables
    sw_nayose = 0

    # Assign values
    tbl_nayose.user_cd = wk_wjaa310.user_cd
    tbl_nayose.nayose_cd = wk_wjaa310.nayose_cd
    tbl_nayose.int_koza_no_daihyo_kbn = '1'

    # Call M521-NAYOSE-SELECT-RTN function
    # This function is not defined in the provided COBOL code, so it's not clear what it does
    # You need to implement this function in Python
    m521_nayose_select_rtn()

    if sw_nayose == 1:
        tbl_cost.btn_daihyo = tbl_nayose.btn
        tbl_cost.int_koza_no_daihyo = tbl_nayose.int_koza_no
    else:
        tbl_nayose.int_koza_no_daihyo_kbn = '2'
        m521_nayose_select_rtn()
        if sw_nayose == 1:
            tbl_cost.btn_daihyo = tbl_nayose.btn
            tbl_cost.int_koza_no_daihyo = tbl_nayose.int_koza_no
        else:
            # Call M522-NAYOSE-UPDATE-RTN function
            # This function is not defined in the provided COBOL code, so it's not clear what it does
            # You need to implement this function in Python
            m522_nayose_update_rtn()
            tbl_cost.btn_daihyo = tbl_nayose.btn
            tbl_cost.int_koza_no_daihyo = tbl_nayose.int_koza_no

    # Continue assigning values
    tbl_cost.user_cd = wk_wjaa310.user_cd
    tbl_cost.nayose_cd = wk_wjaa310.nayose_cd
    tbl_cost.tokukoza_hantei_kbn1 = wk_wjaa310.tokukoza_hantei_kbn1
    tbl_cost.naigai_kbn = wk_wjaa310.naigai_kbn
    tbl_cost.shohin_kbn = wk_wjaa310.shohin_kbn
    tbl_cost.meg_cd = wk_wjaa310.meg_cd
    tbl_cost.sinkyu_kbn = wk_wjaa310.sinkyu_kbn
    tbl_cost.zan_suryo = wk_wjaa310.suryo

    # Calculate heikin_tanka
    # This part is not clear in the provided COBOL code, so it's not clear how to translate it to Python
    # You need to implement this part in Python

    cur = con.cursor()

    # Insert into COST_BATCH table
    cur.execute("""
        INSERT INTO COST_BATCH (
            USER_CD,
            NAYOSE_CD,
            TOKUKOZA_HANTEI_KBN1,
            BTN_DAIHYO,
            INT_KOZA_NO_DAIHYO,
            NAIGAI_KBN,
            SHOHIN_KBN,
            MEG_CD,
            SINKYU_KBN,
            ZAN_SURYO,
            HEIKIN_TANKA,
            ZAN_KIN,
            UPDATE_KBN,
            UPDATE_YMD,
            UPDATE_PROGRAM,
            CREATE_TIMESTAMP,
            UPDATE_TIMESTAMP,
            DELETE_TIMESTAMP,
            UPDATE_PC_ADDRESS,
            UPDATE_SYAIN_NO
        ) VALUES (
            :1, :2, :3, :4, :5, :6, :7, :8, :9, :10, :11, :12, :13, :14, :15, :16, :17, :18, :19, :20
        )""", (
        tbl_cost.user_cd,
        tbl_cost.nayose_cd,
        tbl_cost.tokukoza_hantei_kbn1,
        tbl_cost.btn_daihyo,
        tbl_cost.int_koza_no_daihyo,
        tbl_cost.naigai_kbn,
        tbl_cost.shohin_kbn,
        tbl_cost.meg_cd,
        tbl_cost.sinkyu_kbn,
        tbl_cost.zan_suryo,
        tbl_cost.heikin_tanka,
        tbl_cost.zan_kin,
        tbl_cost.update_kbn,
        tbl_cost.update_ymd,
        tbl_cost.update_program,
        tbl_cost.create_timestamp,
        tbl_cost.update_timestamp,
        tbl_cost.delete_timestamp,
        tbl_cost.update_pc_address,
        tbl_cost.update_syain_no
    ))

    # Check SQLCODE
    if cur.rowcount > 0:
        wk_wjala310.rtn_cd = 0
        # Update wk_wjaa310
        wk_wjaa310.zan_suryo_go = tbl_cost.zan_suryo
        wk_wjaa310.heikin_tanka_go = tbl_cost.heikin_tanka
        wk_wjaa310.zan_kin_go = tbl_cost.zan_kin
    else:
        wk_wjala310.rtn_cd = -1
        err_sql = sql_constant_area.cns_sql_insert
        err_table_id = sql_constant_area.cns_tbl_const
        # Call M990-ERROR-RTN function
        # This function is not defined in the provided COBOL code, so it's not clear what it does
        # You need to implement this function in Python
        sefl.m990_error_rtn()

    # Commit changes and close cursor
    con.commit()
    cur.close()
`;


export const FROM_DOC = `
# 詳細設計書

## 1. 概要
本プログラムは、T+2制度開始年月日をデータベースから取得する処理を行います。取得したデータはワークエリアに格納され、SQLの実行結果に応じてエラーハンドリングを行います。

## 2. プログラムID
M155-GET-SEIDO-KAISHI-YMD-RTN

## 3. 処理概要
- データベースからT+2制度開始年月日を取得する。
- SQLCODEを評価し、成功時はデータをワークエリアに移動し、失敗時はエラーメッセージを設定し、エラー処理ルーチンを実行する。

## 4. 入出力
- 入力：なし（データベースから直接取得）
- 出力：ワークエリア（WK-SEIDO-KAISHI-YMD）

## 5. 処理詳細
### 5.1 データベースからのデータ取得
- SQLを実行し、\`WJATSDKJ\`テーブルから\`SEIDO_ID\`が'001'の\`SEIDO_KAISHI_YMD\`を取得する。
- 取得したデータは\`TBL-WJATSDKJ\`に格納される。

### 5.2 SQLCODEの評価
- SQLCODEが\`CNS-ORA-SUCCESS\`（成功）の場合：
  - \`TBL-WJATSDKJ\`の\`SEIDO-KAISHI-YMD\`を\`WK-SEIDO-KAISHI-YMD\`に移動する。
- SQLCODEが上記以外（失敗）の場合：
  - エラーメッセージ出力情報を設定する。
  - エラーメッセージ出力処理（M990-ERROR-RTN）を実行する。

### 5.3 エラーメッセージ出力情報の設定
- 処理タイプ、メッセージタイプ、プログラムIDなど、エラーに関する情報をログ領域に設定する。
- エラー詳細コードにはSQLCODEを設定する。
- エラー発生テーブルIDには\`CNS-TBL-WJATSDKJ\`を設定する。
- エラーSQLには\`CNS-SQL-SELECT\`を設定する。
- エラーキー情報には\`ERR-MSG-WJATSDKJ\`を設定する。

### 5.4 エラーメッセージ出力処理
- 設定されたエラー情報をもとに、エラーメッセージ出力処理（M990-ERROR-RTN）を実行する。

## 6. エラーハンドリング
- SQL実行失敗時には、エラーメッセージ出力処理を実行し、エラー情報をログに記録する。

## 7. 備考
- 本プログラムは、データベースアクセスに依存するため、データベースの状態によってはエラーが発生する可能性がある。
- エラーメッセージの内容やログの詳細は、システムのエラーハンドリング基準に従う。

## 8. テストケース
- 正常系：\`SEIDO_ID\`が'001'のデータが存在し、正しく取得できること。
- 異常系：\`SEIDO_ID\`が'001'のデータが存在しない場合、またはデータベース接続に失敗した場合にエラーメッセージが出力されること。
`


export const TO_DOC=`
### コアドメイン：T+2制度開始年月日の取得

#### 概要
- 本プロセスは、ビジネスにとって重要なT+2制度開始年月日をデータベースから取得することに特化しています。
- データの取得と基本的なエラーハンドリングを行い、取得したデータはビジネスロジックの実行に使用されます。

#### 処理概要
- データベースからT+2制度開始年月日を取得する。
- 成功時はデータをワークエリアに移動し、失敗時は基本的なエラーハンドリングを行う。

#### 処理詳細
1. **データベースからのデータ取得**
   - \`WJATSDKJ\`テーブルから\`SEIDO_ID\`が'001'の\`SEIDO_KAISHI_YMD\`を取得する。
2. **SQLCODEの評価**
   - 成功時：取得したデータをワークエリアに移動する。
   - 失敗時：基本的なエラーハンドリングを行う。

### サポートドメイン：エラーハンドリング

#### 概要
- エラーが発生した場合の詳細なエラーハンドリングを担当します。
- エラー情報の設定、ログ記録、エラーメッセージの出力などを行います。

#### 処理詳細
1. **エラーメッセージ出力情報の設定**
   - エラーに関する詳細情報（処理タイプ、メッセージタイプ、プログラムIDなど）をログ領域に設定する。
2. **エラーメッセージ出力処理**
   - 設定されたエラー情報をもとに、エラーメッセージ出力処理を実行する。

### 汎用ドメイン：データベースアクセスとファイルシステム操作

#### 概要
- データベースアクセスとファイルシステム操作は、業界全体で共通の機能やサービスとして扱われます。
- 本プログラムでは、データベースからのデータ取得とエラーログの記録に使用されます。

#### 処理詳細
1. **データベースアクセス**
   - SQLを実行し、必要なデータを取得する。
2. **ファイルシステム操作**
   - エラーログの記録やエラーメッセージの出力に使用する。

### 備考
- 本プログラムは、データベースの状態やファイルシステムの状態に依存するため、これらの状態によってはエラーが発生する可能性があります。
- エラーメッセージの内容やログの詳細は、システムのエラーハンドリング基準に従います。

### テストケース
- **正常系**：\`SEIDO_ID\`が'001'のデータが存在し、正しく取得できること。
- **異常系**：\`SEIDO_ID\`が'001'のデータが存在しない場合、またはデータベース接続に失敗した場合にエラーメッセージが出力されること。
`;