/** Real certificates (generated with openssl-compatible tooling) and what `describeCertificate` reads from each: the PEM, its subject and issuer common names (or the whole name when there is no CN), its end of validity and whether its key is RSA. */
export interface TestCert {
  name: string
  pem: string
  summary: { commonName: string; issuerCommonName: string; validTo: string; isRsa: boolean }
}

export const CERTS: TestCert[] = [
  {
    name: 'rsa-valid',
    pem: '-----BEGIN CERTIFICATE-----\nMIICpDCCAYygAwIBAgIBAjANBgkqhkiG9w0BAQsFADASMRAwDgYDVQQDDAdUZXN0\nIENBMCAXDTIwMDEwMTAwMDAwMFoYDzIwOTkxMjMxMjM1OTU5WjAXMRUwEwYDVQQD\nDAxBbGljZSBTaWduZXIwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC0\ntlRZV0Ockjjjg49/pc19BRU2l4FYrVTU2nwpM7L0u0hTChnlXvrgjXIquvNapn9G\n2U+q4aEck0HzGRzvQAqSyM9pSFHSJji4260toogkrmnhVlM1X4JMd3T+8QM4+8AA\nvyBiMlk/xyfAQQ/qSf8xHEJlhu2fYh2b+2Sz0mrh37JcLJkhRQl2zj/pXNuwLlI0\n6yfKwoaiuy+wrOIK8oi1LfGrYkrdeFdxIs8ITnMYCLugnLLdbJm0zZnTeCBQFszH\nez7/p9aVZy171eJxlDEBJEwYwKTXvX2ndgO6A1HpZTlBfcsNbTM/s8AGmhSFPT6j\nPhs7VuFh2mhYQmRnphj1AgMBAAEwDQYJKoZIhvcNAQELBQADggEBABOK+O2KC1RM\nYXLZ9YCbmnCwppKQRFClx2bHHBGAwe8R78KQvyenwJHWPNI35deKBbw2ZePp/Gcu\n6hBLvjiKeBNkPrQ+Ymh3Zukout7tRGzvW3Ftsciz94XUG2F3L+w2790/vmyGwQ58\nLce555ytJ/9tt53BeIbWZsEc1vnwj/he0GdqkuPsKx29yM131tTVxA2CZb3fRnhN\nXQLm2x01ocoASw4iBtkTnWN51rT5ItAMoIXm7A056DMxpJSfFMdlQzYeKyHZJTKn\nqK7p373+3blzEEK7MHNo/zzcI5sZrNW9fKOj8PUBe7JRp8Os+hZluMKHcG+5smUM\n3vrH/0ToqNc=\n-----END CERTIFICATE-----\n',
    summary: {
      commonName: 'Alice Signer',
      issuerCommonName: 'Test CA',
      validTo: '2099-12-31T23:59:59.000Z',
      isRsa: true,
    },
  },
  {
    name: 'rsa-expired',
    pem: '-----BEGIN CERTIFICATE-----\nMIICpTCCAY2gAwIBAgIBAzANBgkqhkiG9w0BAQsFADAWMRQwEgYDVQQDDAtCb2Ig\nRXhwaXJlZDAeFw0xOTAxMDEwMDAwMDBaFw0yMTAxMDEwMDAwMDBaMBYxFDASBgNV\nBAMMC0JvYiBFeHBpcmVkMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\nusryEMM80mANgAy4xgIfscZiLLG/UsJSm9IWQXMf+49OylpWg5K2Wyfthr8uruwg\nRsl+KhuG/BzhHqztirdo6K89bjjIpPkEpcfuU5DTkbzOulDI19kqpnHVTpplvalm\nNolWSlXF9YPUYKEF47il/A8pPv6Lj9Po/LVQ8Y5V1icOGficO9B1avDAkhYmJmb8\nG8UBGnsVjDCE/IfRBPoUlEjHb3FviP0e7IfGuQxt/uybtoXnmwxHAm/OPCPTGJab\nPIicoSGPR7XeyzGVTyiSBp1/bqYF4MoTRqz3yHquv9f9eqR+bUVvkeR6G/QtZfAy\nAN2e94JClqNjVwgr7NNXzQIDAQABMA0GCSqGSIb3DQEBCwUAA4IBAQAucaS1Wmdz\nRFTpfaw9pudbRy7USNzmXNgGg22Zijze55u8Yizr59fEQjdAaDrog0us5ORX2VQu\nNqK+MkzfG/gaNYR2DrEFamaO0p3E9SrMGMHQLzGZ8kdDeAU336tDbow25C7gCID8\nWxRn5Lx1YtfOXO26jjGly2A0JOhVzQB9eQTtK0ieGEsQYt2VUyq6QJfeT7dhuBNa\n82bCiiew4lYI4jOW1CHAiuYyRWQc5AKIzRRDLBAFIAbQNR0t/tdR/3BkOg263UzY\nIOqS3lMYJMxUSJaZlXJBgkYxwnEsiowpZf6h2X7n8CkV/dmY/pmWitJkM12b1gDK\nwOlCyUXfOgpT\n-----END CERTIFICATE-----\n',
    summary: {
      commonName: 'Bob Expired',
      issuerCommonName: 'Bob Expired',
      validTo: '2021-01-01T00:00:00.000Z',
      isRsa: true,
    },
  },
  {
    name: 'ec',
    pem: '-----BEGIN CERTIFICATE-----\nMIIBFDCBu6ADAgECAgEEMAoGCCqGSM49BAMCMBMxETAPBgNVBAMMCENhcm9sIEVD\nMCAXDTIwMDEwMTAwMDAwMFoYDzIwOTkxMjMxMjM1OTU5WjATMREwDwYDVQQDDAhD\nYXJvbCBFQzBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABE/sBCe+H7TZZWfbTW+a\njveABW7UQ7p9Bj54Ho2dpcgSu1bieAQTUBm7gYIdRfEg4/t32WDK4Fu1UrKDEVGB\n7hYwCgYIKoZIzj0EAwIDSAAwRQIgE5U4P4KlI9tk02PfHZcsBUJu4d5mj8hwbxyA\nufuswi4CIQDSfFAdM4X25+qBQzdRxQ/aYHDhhf48ttIUE4Mh4ZPbow==\n-----END CERTIFICATE-----\n',
    summary: {
      commonName: 'Carol EC',
      issuerCommonName: 'Carol EC',
      validTo: '2099-12-31T23:59:59.000Z',
      isRsa: false,
    },
  },
  {
    name: 'rsa-no-cn',
    pem: '-----BEGIN CERTIFICATE-----\nMIICoTCCAYmgAwIBAgIBBTANBgkqhkiG9w0BAQsFADATMREwDwYDVQQKDAhOb0NO\nIE9yZzAgFw0yMDAxMDEwMDAwMDBaGA8yMDk4MDYzMDEyMDAwMFowEzERMA8GA1UE\nCgwITm9DTiBPcmcwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCfKvJT\nkfgMErf+9Vl0U+DXUtviSVVhWQvsoaWu/XuuwRp6ZPEq9eF3vHQS9jR/XCpK+b2z\niB4pCrRAfd9qxX6kxsYgKsUPxsJlAvmloc+7DLW06VvhD8Gm6aJiCA/toXHTMbmY\n0bs1+PJJbd5wbTmkA1osfFkYbrh/+54BcGx4CHDRG/E6lWxjv8TzusayNdzlJXre\nu9YxeFRpyHmWM0SNzTC/FD/8qhg87O9mEpHhHyO5I2KAzvFvkqJzVDESFC/Skrd0\nCWXqhRkUfwynNtHyQZGT7a5KxqcFDLCdaAe8kpuqa3iT1VSl4Bhu+rZTJKjD5miJ\n0fyKSbdsDAc1TsO/AgMBAAEwDQYJKoZIhvcNAQELBQADggEBAJrWqECzx11hhSsH\n/XN7palWJNbjbztLdiJDP35nU5SbgA0FxYpEPgZeF3LCKGOD+DRJqqKmgyOXAG3c\nWp7FWOBC6bMnTt/AxMCXkUqY1vxZYt+BrDMjKWA6iUZF9OkFGqzo8mss9lvvoK+O\nsXJ1Qn4yoXG2An5brfrDwyD+dPOZu8s2nz2UbWikOen8J1X+xOFM50ESbPxDI/OU\nwU+XdaeBa9C/gdKpFSVHnwD2OuvT/Fye1+TwJy7t3Gqmhi81ZhCa6IfgdhN7fZJf\niibQUuqDAPpkaqALkWXXyF2nBo2DIRkcLtYy9F/s5Bh3ncWDEHSToM/RDf+knKlM\netC4/hk=\n-----END CERTIFICATE-----\n',
    summary: {
      commonName: 'O=NoCN Org',
      issuerCommonName: 'O=NoCN Org',
      validTo: '2098-06-30T12:00:00.000Z',
      isRsa: true,
    },
  },
  {
    name: 'rsa-korean',
    pem: '-----BEGIN CERTIFICATE-----\nMIICsTCCAZmgAwIBAgIBBjANBgkqhkiG9w0BAQsFADAbMRkwFwYDVQQDDBDtlZzq\nuIAg7J247Kad7IScMCAXDTIwMDEwMTAwMDAwMFoYDzIwOTcwMzA0MDUwNjA3WjAb\nMRkwFwYDVQQDDBDtlZzquIAg7J247Kad7IScMIIBIjANBgkqhkiG9w0BAQEFAAOC\nAQ8AMIIBCgKCAQEAxJeFkZmzYre5sHyWt79jwEcqtwmFpb1MCDruTXOGa51P2Mh5\n6MArexDE2lb7rt4OBZ/1g41a4Magx4sfxpq1tiBU769W0RfrxIq1jokQjU4zn+nU\nT6eTQEPy0eVgzZbm7UD0LloyKeNBlwQDwhYhOUPQlJOyodia1Evb1Pm45I23xp3t\nu83LvtKVRgGAswsXEAV4VSGG/O2xgc/zvlqOtsMnSoZf8AwfV1fY/4dH3oC7SSmu\n/GZx1wcgj5P21EXMAcbUPrmRQJMLP+Br1myVWLhBPcGB4xhh+M8/uZY7aRUiz32a\n4rNsjF5mS/ZuvIw5/f5jwdK2kj0m8J5OgWtYJwIDAQABMA0GCSqGSIb3DQEBCwUA\nA4IBAQCNO5VK+e0a9Q7pRh7Vt2dmshrvFqPYczLwu471aFAFGLhxxapykqG10/IF\nWhyFB5HauViw14iSR5YJ4R2mKA5sd4VWkIq5T1vw9jc5bVGaStxwLlMrv5TbRdGL\n6LgTVgCb/PvL1sxydcgTI3Owggs7S5s17+2SWkmvCU737Q2xuQ75kJ+uN7gsgjuT\nS/CQQh7xuKRlOGIl3J1Gps451To/AAjRquQHiT0wawE610UNHLaQLVXtbT1aj5iS\n1/mZmpnZBOGL1j4tq46SQKavVRapy6EU7bRompl4U2yhImYZjHdUNlYIMQbkyiAA\n873QTniVh08TVicbNhMJFlcBthat\n-----END CERTIFICATE-----\n',
    summary: {
      commonName: '\ud55c\uae00 \uc778\uc99d\uc11c',
      issuerCommonName: '\ud55c\uae00 \uc778\uc99d\uc11c',
      validTo: '2097-03-04T05:06:07.000Z',
      isRsa: true,
    },
  },
  {
    name: 'rsa-late',
    pem: '-----BEGIN CERTIFICATE-----\nMIICoDCCAYigAwIBAgIBBzANBgkqhkiG9w0BAQsFADASMRAwDgYDVQQDDAdUZXN0\nIENBMCAXDTIwMDEwMTAwMDAwMFoYDzIwOTYwMTAxMDAwMDAwWjATMREwDwYDVQQD\nDAhaZWQgTGF0ZTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAPH2OxTI\ng6Mdh1DnOXV3gniP4EHt5v6dGhzMLQsJoptkG/u7Nh7HtiUyrGLt07BpPpYJcjMK\n4BNzJucgTPfMeZ8hzIBe2Pk1acMxZEBMrJZ72gyPXDZ26bE3DEn3s6FooCwMKmrI\nrXEuOJ5YIJGc+lwNnYJGPYgWnG5sMaFI4NJGGHTtWc8D01uNaVzwmXAE6x7wUoZm\nt1DcH14x0m2PYXKFD6AvbD82rbhbFtp+KSafN7Qpblo4DDaJDlxOjs73Xv4UIPEH\nfTBnDFPhCEto/fY1iqVR0+6R8pl1JsFhO8O1zh1V5ef2T1HVi7+WWp2JNPPqd+gi\n3WEvkGarOx5djc0CAwEAATANBgkqhkiG9w0BAQsFAAOCAQEAdACe1sR7VUNRK9A3\nNuREg/tmNhhvviaQsro7nnnpEwZhoeW+Jx7R+MWmQTfWTjAqdqQIDAnevfHIKr59\nPvkvh2HIbeI2nDB9/B4MIPTpVC+cakwUpg1hQFo5WP4XzMtz5H4S4giW2wrhaSSs\no71a33+U1K9ayxOZKBYfT97qHx+GTGltfzzx5Bs5vf2O6F/qWK+1voCyGJGDHi/m\nGOG6271ewDINbs0XZlOO4BUjiHXy+yvqW+PpyzAO+ZefBdIP3Io/ytT7b4qO9J34\nTtLksmoJQHHjL2zAlUhNyxnz4Ts+v4G/QfG6W0Y9DFtHNPqjDAFYNb0USFCR1ujP\nU29Sig==\n-----END CERTIFICATE-----\n',
    summary: {
      commonName: 'Zed Late',
      issuerCommonName: 'Test CA',
      validTo: '2096-01-01T00:00:00.000Z',
      isRsa: true,
    },
  },
]
