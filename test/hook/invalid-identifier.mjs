import * as lib from '../fixtures/invalid-identifier.js'
import { strictEqual } from 'assert'

strictEqual(typeof lib['one.two'], 'function')
