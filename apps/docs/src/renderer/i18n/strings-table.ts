import { defineStrings } from '@seuoffice/i18n'

const en = {
  ribbonTableStyleOptions: 'Table Style Options',
  ribbonTableFirstRow: 'Header Row',
  ribbonTableLastRow: 'Total Row',
  ribbonTableBandedRows: 'Banded Rows',
  ribbonTableFirstColumn: 'First Column',
  ribbonTableLastColumn: 'Last Column',
  ribbonTableBandedColumns: 'Banded Columns',
  ribbonTablePresetGrid: 'Plain Grid',
  ribbonTablePresetBlueHeader: 'Blue Header',
  ribbonTablePresetBlueBanded: 'Blue Banded',
  ribbonTablePresetGrayBanded: 'Gray Banded',
  ribbonTablePresetGreenHeader: 'Green Header',
  ribbonAutoFit: 'AutoFit',
  ribbonAutoFitContents: 'AutoFit Contents',
  ribbonAutoFitWindow: 'AutoFit Window',
  ribbonFixedColumnWidth: 'Fixed Column Width',
  ribbonRepeatHeaderRows: 'Repeat Header Rows',
  ribbonTableProperties: 'Table Properties',
  ribbonTableData: 'Table',
  ribbonHorizontalPosition: 'Horizontal position',
  ribbonVerticalPosition: 'Vertical position',
  ribbonDistanceFromText: 'Distance from text',
  ribbonCellMargins: 'Default cell margins',
}

const ko: Record<keyof typeof en, string> = {
  ribbonTableStyleOptions: '표 스타일 옵션',
  ribbonTableFirstRow: '머리글 행',
  ribbonTableLastRow: '요약 행',
  ribbonTableBandedRows: '줄무늬 행',
  ribbonTableFirstColumn: '첫째 열',
  ribbonTableLastColumn: '마지막 열',
  ribbonTableBandedColumns: '줄무늬 열',
  ribbonTablePresetGrid: '기본 격자',
  ribbonTablePresetBlueHeader: '파란 머리글',
  ribbonTablePresetBlueBanded: '파란 줄무늬',
  ribbonTablePresetGrayBanded: '회색 줄무늬',
  ribbonTablePresetGreenHeader: '초록 머리글',
  ribbonAutoFit: '자동 맞춤',
  ribbonAutoFitContents: '내용에 자동으로 맞춤',
  ribbonAutoFitWindow: '창에 자동으로 맞춤',
  ribbonFixedColumnWidth: '고정 열 너비',
  ribbonRepeatHeaderRows: '머리글 행 반복',
  ribbonTableProperties: '표 속성',
  ribbonTableData: '표',
  ribbonHorizontalPosition: '가로 위치',
  ribbonVerticalPosition: '세로 위치',
  ribbonDistanceFromText: '텍스트와의 간격',
  ribbonCellMargins: '기본 셀 여백',
}

/** Table Design / Table Layout controls; every locale has its own complete key set. */
export const tableStrings = defineStrings({
  en,
  ko,
})
