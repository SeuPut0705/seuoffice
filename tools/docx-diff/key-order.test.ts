import { describe, expect, it } from 'vitest'
import { keyOrderDifferences, keysAsWritten, parseKeepingOrder } from './key-order'

describe('parseKeepingOrder', () => {
  it('gives what JSON.parse gives', () => {
    const texts = [
      '{"a":1,"b":[true,false,null,{"c":"d"}],"e":{}}',
      '[]',
      '"plain"',
      '"a\\"b\\\\"',
      '"\\\\"',
      '"\\u00e9\\ud83d\\ude00\\n\\t"',
      '"\ud83d\ude00 raw"',
      '-0.5',
      '1e21',
      '1.5E-7',
      '0',
      ' { "a" : [ 1 , 2 ] , "b" : "x" } ',
      '{"":0,"a b":{"":[]}}',
      '{"a":"}","b":"]","c":"\\"}"}',
    ]
    for (const text of texts) expect(parseKeepingOrder(text)).toEqual(JSON.parse(text))
  })

  it('keeps an entry named __proto__ as JSON.parse does', () => {
    const parsed = parseKeepingOrder('{"a":1,"__proto__":{"x":2},"b":3}') as object
    expect(Object.keys(parsed)).toEqual(['a', '__proto__', 'b'])
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
  })

  it('refuses what is not JSON', () => {
    for (const text of ['', '{', '{"a"}', '[1,]', '{"a":1,}', 'tru', '1 2', '"open', "{'a':1}"]) {
      expect(() => parseKeepingOrder(text), text).toThrow(SyntaxError)
    }
  })

  it('remembers the written place of keys a JavaScript object moves', () => {
    const parsed = parseKeepingOrder('{"10":"a","b":"c","2":"d"}') as object
    expect(Object.keys(parsed)).toEqual(['2', '10', 'b'])
    expect(keysAsWritten(parsed)).toEqual(['10', 'b', '2'])
  })

  it('shows a key written twice', () => {
    expect(keysAsWritten(parseKeepingOrder('{"a":1,"b":2,"a":3}') as object)).toEqual([
      'a',
      'b',
      'a',
    ])
  })
})

describe('keyOrderDifferences', () => {
  it('finds none where every object has its keys in the same order', () => {
    const value = { a: 1, list: [{ x: 1, y: 2 }], 2: 'two', 10: 'ten' }
    expect(keyOrderDifferences(value, parseKeepingOrder(JSON.stringify(value)))).toEqual([])
  })

  it('finds every object out of order, with where it is', () => {
    const typescript = {
      a: 1,
      list: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      deep: { p: { m: 1, n: 2 } },
    }
    const found = keyOrderDifferences(
      typescript,
      parseKeepingOrder('{"list":[{"x":1,"y":2},{"y":4,"x":3}],"a":1,"deep":{"p":{"n":2,"m":1}}}'),
    )
    expect(found).toEqual([
      { path: '/', typescript: ['a', 'list', 'deep'], rust: ['list', 'a', 'deep'] },
      { path: '/list/1', typescript: ['x', 'y'], rust: ['y', 'x'] },
      { path: '/deep/p', typescript: ['m', 'n'], rust: ['n', 'm'] },
    ])
  })

  it('sees integer keys written in another order than a JavaScript object keeps them', () => {
    // numeric order is where JavaScript puts them, whatever order they were set in
    const typescript = { 10: 'a', 2: 'b' }
    expect(keyOrderDifferences(typescript, parseKeepingOrder('{"2":"b","10":"a"}'))).toEqual([])
    expect(keyOrderDifferences(typescript, parseKeepingOrder('{"10":"a","2":"b"}'))).toEqual([
      { path: '/', typescript: ['2', '10'], rust: ['10', '2'] },
    ])
  })
})
