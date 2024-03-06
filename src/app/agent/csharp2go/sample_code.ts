export const SAMPLE_INSERT_CSHARP = `
using System;
using System.Collections.Generic;
using System.Text;
using TradeWin.Common.Server;
using TradeWin.Flare.Common.Server;
using TradeWin.Flare.Common.Server.Dao;
using TradeWin.Flare.Common.Server.Models;
using TradeWin.Flare.Common.Server.Services;
using TradeWin.Flare.BizCore.Server.Dao;
using TradeWin.Flare.BizCore.Server.Models;
using TradeWin.Flare.BizCore.Server.Services;
using TradeWin.Flare.Business.Server.Dao;
using TradeWin.Flare.Business.Server.Models;

using System.Collections.Specialized;

namespace TradeWin.Flare.Business.Server.Services
{
    public partial class TradeRecord_Del
    {
        NameValueCollection TrdRecordLbl = TWLabel.getList("TrdRecord");

        /// <summary>
        /// サービス処理
        /// 下記の5項目を使用する。
        /// inObj.TransactionNo
        /// inObj.BranchCode
        /// inObj.AccountCode
        /// inObj.AccountType
        /// inObj.InputAppDate
        /// 1.対象の明細データを検索して、取消処理を行う。
        /// </summary>
        /// <param name="inObj">入力データ</param>
        public void _TradeRecord_Del(CTransactionBase inObj)
        {

            //入力データの口座区分により、対象のテーブルを変更する。
            if (((CTransactionCustBase)inObj).AccountType == TWCode.ACCOUNT_TYPE.ACCIDENT ||
                ((CTransactionCustBase)inObj).AccountType == TWCode.ACCOUNT_TYPE.CORPORATE ||
                ((CTransactionCustBase)inObj).AccountType == TWCode.ACCOUNT_TYPE.INDIVISUAL)
            {
                // 【現物取引履歴（顧客）】
                CTradeRecord tradeRecord = new CTradeRecord();

                List<TWDBWhere> condition = new List<TWDBWhere>();
                condition.Add(new TWDBWhereEqual("TransactionNo", inObj.TransactionNo));
                condition.Add(new TWDBWhereEqual("BranchCode", inObj.BranchCode));
                condition.Add(new TWDBWhereEqual("AccountCode", ((CTransactionCustBase)inObj).AccountCode));

                CTradeRecord[] tradeRecordLst = CTradeRecordDao.Select(condition.ToArray());
                foreach (CTradeRecord i in tradeRecordLst)
                {
                    //取消処理
                    /*
                     * 1.当日取消は、Delete(物理削除)
                     * 2.過日取消は、約定の場合のみ（受渡日を過ぎるまで、取消可能。）。データのUpdate(①)とInsert(反転データの挿入)（②）
                     * 
                     */

                    if (inObj.InputAppDate == TWSystem.GetCommon().Today) //【当日中の取消】
                    {
                        i.Delete();//物理削除
                    }
                    else //過日の取消【約定の場合のみ】
                    {
                        // 約定以外の過日取消は取引履歴データを物理削除する
                        if (i.TradeKind != TWCode.TRADEKIND.LENDINGSTOCK_ENTRY_IN
                            && i.TradeKind != TWCode.TRADEKIND.LENDINGSTOCK_ENTRY_OUT
                            && i.TradeKind != TWCode.TRADEKIND.BACK_TO_APPRAISAL_LOSS
                            && i.TradeKind != TWCode.TRADEKIND.BACK_TO_APPRAISAL_PROFIT
                            && i.TradeKind != TWCode.TRADEKIND.TRANSFER_TO_APPRAISAL_LOSS
                            && i.TradeKind != TWCode.TRADEKIND.TRANSFER_TO_APPRAISAL_PROFIT
                            && i.TradeKind != TWCode.TRADEKIND.TRANSFER_TO_LOSS
                            && i.TradeKind != TWCode.TRADEKIND.TRANSFER_TO_PROFIT
                            && i.TradeKind != TWCode.TRADEKIND.TRADE_BUY
                            && i.TradeKind != TWCode.TRADEKIND.TRADE_SELL
                            && i.TradeKind != TWCode.TRADEKIND.PURCHASE
                            && i.TradeKind != TWCode.TRADEKIND.FUND_CANCEL
                            && i.TradeKind != TWCode.TRADEKIND.OFFERING)
                        {
                            i.Delete();// 物理削除
                            continue;
                        }
                        i.CorrectionFlg = TWCode.FLG.ON;
                        i.CorrectionAppDate = TWSystem.Today;
                        i.Update();

                        //②-1. 取引履歴
                        //MovingQuantity：反転させる。
                        i.MovingQuantity = i.MovingQuantity * (-1);
                        foreach (CTradeRecordMoney j in i.TradeRecordMoney)
                        {
                            j.Amount = j.Amount * (-1);
                            j.Quantity = j.Quantity * (-1);//ADD

                            if (j.Amount >= 0)
                            {
                                //CR
                                j.Cr = j.Amount;
                                //DR
                                j.Dr = null;
                            }
                            else
                            {
                                //CR
                                j.Cr = null;
                                //DR
                                j.Dr = -j.Amount;
                            }
                        }
                        
                        //②-3.取引履歴（証券）
                        //Quantity：反転させる。
                        foreach (CTradeRecordSec k in i.TradeRecordSec)
                        {
                            k.Quantity = k.Quantity * (-1);
                        }

                        //i.AddedOutline = TWCode.CONFIG_PRO.ADDED_ABSTRACT_CANCEL + " " + TWDateTime.FormatDate(TWSystem.Today, TWDateFmtType.YYYYMMDD, TWDateFmtType.MMDDSL); ; // 取消 MM/DD
                        i.AddedOutline = TrdRecordLbl["AddedOutLineCancel"] + " " + TWDateTime.FormatDate(TWSystem.Today, TWDateFmtType.YYYYMMDD, TWDateFmtType.YYMMDDSL); ; // 取消 YY/MM/DD
                        i.InputType = "2";  // 過日取消
                        i.Insert();
                    }
                }
            }
            else if (((CTransactionCustBase)inObj).AccountType == TWCode.ACCOUNT_TYPE.SELF)
            {
                //【自己取引履歴】
                CSelfTradeRecord tradeRecord = new CSelfTradeRecord();

                List<TWDBWhere> condition = new List<TWDBWhere>();
                condition.Add(new TWDBWhereEqual("TransactionNo", inObj.TransactionNo));
                condition.Add(new TWDBWhereEqual("BranchCode", inObj.BranchCode));
                condition.Add(new TWDBWhereEqual("AccountCode", ((CTransactionCustBase)inObj).AccountCode));

                CSelfTradeRecord[] tradeRecordLst = CSelfTradeRecordDao.Select(condition.ToArray());

                foreach (CSelfTradeRecord one in tradeRecordLst)
                {
                    if (inObj.InputAppDate == TWSystem.GetCommon().Today) //【当日中の取消】
                    {
                        one.Delete();// 物理削除
                    }
                    else // 過日の取消
                    {
                        // 約定以外の過日取消は取引履歴データを物理削除する
                        if (one.TradeKind != TWCode.TRADEKIND.LENDINGSTOCK_ENTRY_IN
                            && one.TradeKind != TWCode.TRADEKIND.LENDINGSTOCK_ENTRY_OUT
                            && one.TradeKind != TWCode.TRADEKIND.BACK_TO_APPRAISAL_LOSS
                            && one.TradeKind != TWCode.TRADEKIND.BACK_TO_APPRAISAL_PROFIT
                            && one.TradeKind != TWCode.TRADEKIND.TRANSFER_TO_APPRAISAL_LOSS
                            && one.TradeKind != TWCode.TRADEKIND.TRANSFER_TO_APPRAISAL_PROFIT
                            && one.TradeKind != TWCode.TRADEKIND.TRANSFER_TO_LOSS
                            && one.TradeKind != TWCode.TRADEKIND.TRANSFER_TO_PROFIT
                            && one.TradeKind != TWCode.TRADEKIND.TRADE_BUY
                            && one.TradeKind != TWCode.TRADEKIND.TRADE_SELL
                            && one.TradeKind != TWCode.TRADEKIND.PURCHASE
                            && one.TradeKind != TWCode.TRADEKIND.FUND_CANCEL
                            && one.TradeKind != TWCode.TRADEKIND.OFFERING)
                        {
                            one.Delete();// 物理削除
                            continue;
                        }
                        one.CorrectionFlg = TWCode.FLG.ON;
                        one.CorrectionAppDate = TWSystem.Today;
                        one.Update();
                        if (one.Quantity > 0)
                        {
                            one.DrQuantity = one.DrQuantity * (-1);
                        }
                        else if (one.Quantity < 0)
                        {
                            one.CrQuantity = one.CrQuantity * (-1);
                        }
                        if (one.Quantity != null) one.Quantity = one.Quantity * (-1);
                        if (one.Amount > 0)
                        {
                            one.CrAmount = one.CrAmount * (-1);
                        }
                        else if (one.Amount < 0)
                        {
                            one.DrAmount = one.DrAmount * (-1);
                        }
                        if (one.Amount != null) one.Amount = one.Amount * (-1);
                        if (one.BaseCcyAmount > 0)
                        {
                            one.BaseCcyCrAmount = one.BaseCcyCrAmount * (-1);
                        }
                        else if (one.BaseCcyAmount < 0)
                        {
                            one.BaseCcyDrAmount = one.BaseCcyDrAmount * (-1);
                        }
                        if (one.BaseCcyAmount != null) one.BaseCcyAmount = one.BaseCcyAmount * (-1);
                        if (one.TradeKind != TWCode.TRADEKIND.BACK_TO_APPRAISAL_LOSS &&
                          one.TradeKind != TWCode.TRADEKIND.BACK_TO_APPRAISAL_PROFIT &&
                          one.TradeKind != TWCode.TRADEKIND.TRANSFER_TO_APPRAISAL_LOSS &&
                          one.TradeKind != TWCode.TRADEKIND.TRANSFER_TO_APPRAISAL_PROFIT &&
                          one.TradeKind != TWCode.TRADEKIND.TRANSFER_TO_LOSS &&
                          one.TradeKind != TWCode.TRADEKIND.TRANSFER_TO_PROFIT
                          )
                        {
                            one.BookDate = TWSystem.Today.CompareTo(one.BookDate) > 0 ? TWSystem.Today : one.BookDate;
                        }
                        one.AddedOutline = TrdRecordLbl["AddedOutLineCancel"] + " " + TWDateTime.FormatDate(TWSystem.Today, TWDateFmtType.YYYYMMDD, TWDateFmtType.YYMMDDSL); ; // 取消 YY/MM/DD
                        one.InputType = "2";  // 過日取消
                        one.Insert();
                    }

                }
            }
        }
    }
}
`;

export const SAMPLE_INSERT_GOLANG = `
package Server

import (
    "myGoProject/TradeWin/Flare/Common/TWCode"
    "myGoProject/TradeWin/Flare/Common/TWDateFmtType"
    "myGoProject/TradeWin/Flare/Common/TWDateTime"
    "myGoProject/TradeWin/Flare/Common/TWLabel"
    "myGoProject/TradeWin/Flare/Common/TWSystem"
)

type TradeRecord_Del struct {
    TrdRecordLbl map[string]string
}

// サービス処理
// 下記の5項目を使用する。
// inObj.TransactionNo
// inObj.BranchCode
// inObj.AccountCode
// inObj.AccountType
// inObj.InputAppDate
// 1.対象の明細データを検索して、取消処理を行う。


func (t *TradeRecord_Del) _TradeRecord_Del(inObj *CTransactionBase) {
    t.TrdRecordLbl = TWLabel.GetList("TrdRecord")

    //入力データの口座区分により、対象のテーブルを変更する。
    if (*CTransactionCustBase)(inObj).AccountType == TWCode.GetAccountType().ACCIDENT ||
       (*CTransactionCustBase)(inObj).AccountType == TWCode.GetAccountType().CORPORATE ||
       (*CTransactionCustBase)(inObj).AccountType == TWCode.GetAccountType().INDIVISUAL {


       tradeRecord := new(CTradeRecord)

       condition := make([]TWDBWhere, 0)
       condition = append(condition, TWDBWhereEqual("TransactionNo", inObj.TransactionNo))
       condition = append(condition, TWDBWhereEqual("BranchCode", inObj.BranchCode))
       condition = append(condition, TWDBWhereEqual("AccountCode", (*CTransactionCustBase)(inObj).AccountCode))

       tradeRecordLst := new(CTradeRecordDao).Select(condition)
       for _, i := range tradeRecordLst {

          //取消処理
          /*
           * 1.当日取消は、Delete(物理削除)
           * 2.過日取消は、約定の場合のみ（受渡日を過ぎるまで、取消可能。）。データのUpdate(①)とInsert(反転データの挿入)（②）
           *
           */

          if inObj.InputAppDate == TWSystem.GetCommon().Today { //【当日中の取消】

             i.Delete() //物理削除
          } else { //過日の取消【約定の場合のみ】


             // 約定以外の過日取消は取引履歴データを物理削除する
             if i.TradeKind != TWCode.GetTradeKind().LENDINGSTOCK_ENTRY_IN &&
                i.TradeKind != TWCode.GetTradeKind().LENDINGSTOCK_ENTRY_OUT &&
                i.TradeKind != TWCode.GetTradeKind().BACK_TO_APPRAISAL_LOSS &&
                i.TradeKind != TWCode.GetTradeKind().BACK_TO_APPRAISAL_PROFIT &&
                i.TradeKind != TWCode.GetTradeKind().TRANSFER_TO_APPRAISAL_LOSS &&
                i.TradeKind != TWCode.GetTradeKind().TRANSFER_TO_APPRAISAL_PROFIT &&
                i.TradeKind != TWCode.GetTradeKind().TRANSFER_TO_LOSS &&
                i.TradeKind != TWCode.GetTradeKind().TRANSFER_TO_PROFIT &&
                i.TradeKind != TWCode.GetTradeKind().TRADE_BUY &&
                i.TradeKind != TWCode.GetTradeKind().TRADE_SELL &&
                i.TradeKind != TWCode.GetTradeKind().PURCHASE &&
                i.TradeKind != TWCode.GetTradeKind().FUND_CANCEL &&
                i.TradeKind != TWCode.GetTradeKind().OFFERING {

                i.Delete() // 物理削除
                continue
             }

             //① 【既存データ】/////////////////////////////////////////////////////////
             i.CorrectionFlg = TWCode.NewFLG().ON
             i.CorrectionAppDate = TWSystem.Today
             i.Update()

             //② 【訂正データの挿入】///////////////////////////////////////////////////
             //②-1. 取引履歴
             //MovingQuantity：反転させる。
             i.MovingQuantity = i.MovingQuantity * (-1)

             //②-2.取引履歴（金銭）
             //Quantity：反転させる。
             //Amount > Dr Cr
             for _, j := range i.TradeRecordMoney {

                *j.Amount = *j.Amount * (-1)
                j.Quantity = j.Quantity * (-1)

                if *j.Amount >= 0 {


                   j.Cr = j.Amount

                   j.Dr = nil

                } else {


                   j.Cr = nil

                   *j.Dr = -*j.Amount
                }
             }

             //②-3.取引履歴（証券）
             //Quantity：反転させる。
             for _, k := range i.TradeRecordSec {

                k.Quantity = k.Quantity * (-1)
             }

             //i.AddedOutline = TWCode.CONFIG_PRO.ADDED_ABSTRACT_CANCEL + " " + TWDateTime.FormatDate(TWSystem.Today, TWDateFmtType.YYYYMMDD, TWDateFmtType.MMDDSL); ; // 取消 MM/DD
             i.AddedOutline = t.TrdRecordLbl["AddedOutLineCancel"] + " " + TWDateTime.FormatDate(TWSystem.Today, TWDateFmtType.YYYYMMDD, TWDateFmtType.YYMMDDSL) // 取消 YY/MM/DD
             i.InputType = "2"                                                                                                                                   // 過日取消
             i.Insert()
          }
       }

    } else if (*CTransactionCustBase)(inObj).AccountType == TWCode.GetAccountType().SELF {

       //【自己取引履歴】
       tradeRecord := new(CSelfTradeRecord)

       condition := []TWDBWhere{
          TWDBWhereEqual("TransactionNo", inObj.TransactionNo),
          TWDBWhereEqual("BranchCode", inObj.BranchCode),
          TWDBWhereEqual("AccountCode", (*CTransactionCustBase)(inObj).AccountCode),
       }
       tradeRecordLst := new(CSelfTradeRecordDao).Select(condition)

       for _, one := range tradeRecordLst {

          if inObj.InputAppDate == TWSystem.GetCommon().Today { //【当日中の取消】

             one.Delete() // 物理削除

          } else { // 過日の取消

             // 約定以外の過日取消は取引履歴データを物理削除する
             if one.TradeKind != TWCode.GetTradeKind().LENDINGSTOCK_ENTRY_IN &&
                one.TradeKind != TWCode.GetTradeKind().LENDINGSTOCK_ENTRY_OUT &&
                one.TradeKind != TWCode.GetTradeKind().BACK_TO_APPRAISAL_LOSS &&
                one.TradeKind != TWCode.GetTradeKind().BACK_TO_APPRAISAL_PROFIT &&
                one.TradeKind != TWCode.GetTradeKind().TRANSFER_TO_APPRAISAL_LOSS &&
                one.TradeKind != TWCode.GetTradeKind().TRANSFER_TO_APPRAISAL_PROFIT &&
                one.TradeKind != TWCode.GetTradeKind().TRANSFER_TO_LOSS &&
                one.TradeKind != TWCode.GetTradeKind().TRANSFER_TO_PROFIT &&
                one.TradeKind != TWCode.GetTradeKind().TRADE_BUY &&
                one.TradeKind != TWCode.GetTradeKind().TRADE_SELL &&
                one.TradeKind != TWCode.GetTradeKind().PURCHASE &&
                one.TradeKind != TWCode.GetTradeKind().FUND_CANCEL &&
                one.TradeKind != TWCode.GetTradeKind().OFFERING {

                one.Delete() // 物理削除
                continue
             }

             //① ：【既存データ】/////////////////////////////////////////////////////////
             one.CorrectionFlg = TWCode.NewFLG().ON
             one.CorrectionAppDate = TWSystem.Today
             one.Update()

             //② ：【訂正データの挿入】///////////////////////////////////////////////////
             //【Quantity】
             if *one.Quantity > 0 {

                one.DrQuantity = one.DrQuantity * (-1)

             } else if *one.Quantity < 0 {

                one.CrQuantity = one.CrQuantity * (-1)
             }
             if one.Quantity != nil {
                *one.Quantity = *one.Quantity * (-1)
             }

             //【Amount】
             if *one.Amount > 0 {

                one.CrAmount = one.CrAmount * (-1)

             } else if *one.Amount < 0 {

                one.DrAmount = one.DrAmount * (-1)
             }
             if one.Amount != nil {
                *one.Amount = *one.Amount * (-1)
             }

             //【BaseCcyAmount】
             if *one.BaseCcyAmount > 0 {

                one.BaseCcyCrAmount = one.BaseCcyCrAmount * (-1)

             } else if *one.BaseCcyAmount < 0 {

                one.BaseCcyDrAmount = one.BaseCcyDrAmount * (-1)
             }
             if one.BaseCcyAmount != nil {
                *one.BaseCcyAmount = *one.BaseCcyAmount * (-1)
             }

             if one.TradeKind != TWCode.GetTradeKind().BACK_TO_APPRAISAL_LOSS &&
                one.TradeKind != TWCode.GetTradeKind().BACK_TO_APPRAISAL_PROFIT &&
                one.TradeKind != TWCode.GetTradeKind().TRANSFER_TO_APPRAISAL_LOSS &&
                one.TradeKind != TWCode.GetTradeKind().TRANSFER_TO_APPRAISAL_PROFIT &&
                one.TradeKind != TWCode.GetTradeKind().TRANSFER_TO_LOSS &&
                one.TradeKind != TWCode.GetTradeKind().TRANSFER_TO_PROFIT {


                if TWSystem.CompareTo(TWSystem.Today, one.BookDate) > 0 {
                   one.BookDate = TWSystem.Today
                } else {
                   one.BookDate = one.BookDate
                }
             }

             one.AddedOutline = t.TrdRecordLbl["AddedOutLineCancel"] + " " + TWDateTime.FormatDate(TWSystem.Today, TWDateFmtType.YYYYMMDD, TWDateFmtType.YYMMDDSL)
             one.InputType = "2"
             one.Insert()
          }
       }
    }
}
`;
