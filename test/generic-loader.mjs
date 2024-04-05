// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2024 Datadog, Inc.

import * as tsLoader from './typescript/iitm-ts-node-loader.mjs'
import * as regularLoader from '../hook.mjs'
import * as filteredLoader from '../filtered-hook.mjs'
import path from 'path'

const filename = process.env.IITM_TEST_FILE

export const { load, resolve, getFormat, getSource } =
  filename.includes('disabled')
    ? {}
    : (path.extname(filename).slice(-2) === 'ts' ? tsLoader
      : filename.endsWith('filtered-export.mjs') ? filteredLoader
        : regularLoader)
