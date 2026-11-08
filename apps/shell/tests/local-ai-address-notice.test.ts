import { describe, expect, it } from 'vitest'
import { localAddressNotice } from '../src/renderer/src/local-ai'

/**
 * The address notice of the local AI card: plain http to anything but this PC
 * or a private-network IP literal warns that documents go unencrypted, and
 * https to a public IP literal says documents go to that server. Host names
 * are never judged by their look, so a name only warns over http.
 */

describe('localAddressNotice', () => {
  it.each([
    'http://localhost:11434/v1',
    'http://LOCALHOST:11434',
    'http://localhost.:11434',
    'http://127.0.0.1:11434/v1',
    'http://127.5.6.7',
    'http://127.1:8000', // the URL parser folds this into 127.0.0.1
    'http://0.0.0.0:11434',
    'http://10.20.30.40:8000/v1',
    'http://172.16.0.1',
    'http://172.31.255.255:1234',
    'http://192.168.1.10:11434',
    'http://169.254.10.20',
    'http://[::1]:11434/v1',
    'http://[0:0:0:0:0:0:0:1]',
    'http://[::]:11434',
    'http://[fe80::1]:8000',
    'http://[FE80::abcd]',
    'http://[febf::1]',
    'http://[fc00::1]',
    'http://[fd12:3456:789a::1]:11434/v1',
    'http://[::ffff:127.0.0.1]:11434',
    'http://[::ffff:192.168.0.9]',
    '192.168.0.2:11434', // scheme-less reads as http
    'localhost:1234/v1',
  ])('stays quiet for this PC or a private network over http: %s', (address) => {
    expect(localAddressNotice(address)).toBe('none')
  })

  it.each([
    'http://8.8.8.8',
    'http://203.0.113.5:11434/v1',
    'HTTP://203.0.113.5',
    'http://172.15.255.255',
    'http://172.32.0.1',
    'http://192.169.0.1',
    'http://169.253.0.1',
    'http://11.0.0.1',
    'http://[2001:db8::1]:8000/v1',
    'http://[fec0::1]', // just past fe80::/10
    'http://[fe00::1]', // just before fe80::/10, outside fc00::/7
    'http://[::ffff:8.8.8.8]',
    '203.0.113.5:11434', // scheme-less reads as http
  ])('warns that a public IP over http is unencrypted: %s', (address) => {
    expect(localAddressNotice(address)).toBe('unencrypted')
  })

  it.each([
    'http://ollama.local:11434/v1',
    'http://gpu-box:8000',
    'http://GPU-BOX',
    'http://api.example.com/v1',
    'http://foo.localhost', // only the bare name is treated as loopback
  ])(
    'warns for a host name over http (it may still be internal, but it is unencrypted): %s',
    (address) => {
      expect(localAddressNotice(address)).toBe('unencrypted')
    },
  )

  it.each([
    'https://8.8.8.8/v1',
    'https://203.0.113.5:8443',
    'HTTPS://203.0.113.5',
    'https://[2001:db8::1]:8443/v1',
    'https://[2606:4700:4700::1111]',
    'https://[::ffff:8.8.8.8]',
  ])('says documents go to a public IP over https: %s', (address) => {
    expect(localAddressNotice(address)).toBe('remote')
  })

  it.each([
    'https://localhost:8443',
    'https://127.0.0.1:8443/v1',
    'https://10.0.0.2',
    'https://192.168.0.5:8443',
    'https://[::1]:8443',
    'https://[fd00::5]',
    'https://ollama.local/v1',
    'https://gpu-box:8443',
    'https://api.example.com/v1',
  ])('says nothing for https to a private IP or any host name: %s', (address) => {
    expect(localAddressNotice(address)).toBe('none')
  })

  it.each([
    '',
    '   ',
    'http://',
    'ftp://8.8.8.8',
    'http://user:secret@8.8.8.8',
    'http://8.8.8.8/v1?x=1',
    'http://[::ffff:8.8.8.8',
    'http://[fe80::1%25eth0]',
    'http://300.1.1.1',
    42,
    undefined,
    null,
  ])('stays quiet for an address the form will not save: %s', (address) => {
    expect(localAddressNotice(address)).toBe('none')
  })
})
