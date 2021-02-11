const eventKeySym = Symbol('event');
const clientSym = Symbol('client');
const definitionSym = Symbol('definition');
const initializedSym = Symbol('initialized');
const initPromiseSym = Symbol('initPromise');
const loadDefAttemptSym = Symbol('loadDefAttempt');
const lastLoadDefAtSym = Symbol('lastLoadDefAt');

const transformer = {
    String (val) {
        return String(val);
    },
    Int (val, asBigInt) {
        return asBigInt ? BigInt(val) : parseInt(val, 10);
    },
    Double (val) {
        return parseFloat(val);
    },
};

const getType = val => typeof val;
const checkType = (key, val, expectTypes, strict) => {
    const tp = getType(val);
    if ([undefined, null].includes(val)) {
        if (strict) {
            throw new TypeError(`Expect variable \`${key}\` to not be undefined or null.`);
        }
        return;
    }
    if (typeof expectTypes === 'string') {
        expectTypes = [expectTypes];
    }
    if (!expectTypes.includes(tp)) {
        throw new TypeError(`Expect variable \`${key}\` to be one type of ${expectType.join(', ')}, got ${tp}`);
    }
}
const validator = {
    String (key, val, strict) {
        checkType(key, val, 'string', strict);
    },
    Int (key, val, strict) {
        checkType(key, val, ['number', 'bigint'], strict);
        if (strict && (val % 1)) {
            throw new TypeError(`Expect \`${key}\` to be a strict integer, got a decimal number.`);
        }
    },
    Double (key, val, strict) {
        checkType(key, val, 'number', strict);
    }
};

class GIOEvent {
    [initializedSym] = false;
    [loadDefAttemptSym] = 0;
    [lastLoadDefAtSym] = null;
    paramsTree = {};

    constructor (gio, eventKey, options) {
        this[clientSym] = gio;
        this[eventKeySym] = eventKey;
        options = Object.assign(
            {
                strict: true,
                transformBeforeValidate: true,
                requiredKeys: [],
                maxInitAttempt: 3,
                initInterval: 10000,
            },
            options,
        );
        Object.assign(this, options);
    }

    async _loadDefinition () {
        if (this[loadDefAttemptSym] >= this.maxInitAttempt) {
            return { done: true };
        }
        const getEvtDef = () => this[clientSym].getEvent(this[eventKeySym]).catch(() => {});

        if (this[clientSym].initialized) {
            const result = await getEvtDef();
            return { done: true, result };
        }

        const now = Date.now();
        if (this[lastLoadDefAtSym] && now - this[lastLoadDefAtSym] < this.initInterval) {
            return { done: false };
        }
        this[lastLoadDefAtSym] = now;
        this[loadDefAttemptSym]++;
        const result = await getEvtDef();
        return { done: !!result, result };
    }

    async init () {
        if (this[initializedSym]) {
            return this;
        }

        let data;
        if (!this[initPromiseSym]) {
            this[initPromiseSym] = this._loadDefinition()
                .then(data => {
                    if (!data.done) {
                        this[initPromiseSym] = null;
                    }
                    return data;
                });
        }
        data = await this[initPromiseSym];

        const { done, result: def } = data;
        if (!done) {
            return this;
        }
        this[initializedSym] = true;

        if (def) {
            this[definitionSym] = def;
            def.attrs.forEach(attr => {
                const { type, key } = attr;
                this.paramsTree[key] = {
                    type,
                    validate: (val) => validator[type](key, val, this.strict),
                    transforme: (val) => transformer[type](val),
                    isRequired: this.requiredKeys.includes(key),
                };
            });
        } else {
            console.warn(`Fail to load definitions of event "${this[eventKeySym]}", please make sure if it has been created or not.`);
        }

        return this;
    }

    onSuccess (cb) {
        this[clientSym].onSuccess((eventKey, varList) => {
            if (eventKey === this[eventKeySym]) {
                cb(varList);
            }
        });
    }

    onError (cb) {
        this[clientSym].onError((eventKey, varList, err) => {
            if (eventKey === this[eventKeySym]) {
                cb(err, varList);
            }
        });
    }

    batch (uid, data) {
        if (!data) {
            throw new TypeError(`Expect \`data\` to not be empty.`);
        }
        this.init().catch(err => console.error(`Initialize event poster "${this[eventKeySym]}" failed with error: ${err}`));
        let payload = {};
        const keys = Object.keys(data);
        const unassignedRequiredKeys = this.requiredKeys.filter(key => !keys.includes(key));
        if (unassignedRequiredKeys.length) {
            throw new Error(`Params \`${unassignedRequiredKeys.join(', ')}\` are required.`);
        }

        if (this[definitionSym]) {
            keys.forEach(key => {
                const definition = this.paramsTree[key];
                if (this.strict && !definition) {
                    throw new TypeError(`Unexpected params key \`${key}\`.`);
                }
                if (!definition) {
                    return;
                }
                let val = data[key];
                if (definition.isRequired && [undefined, null].includes(val)) {
                    throw new Error(`Param \`${key}\` is required.`);
                }
                if (this.transformBeforeValidate) {
                    val = definition.transforme(val);
                }
                definition.validate(val);
                payload[key] = val;
            });
        } else {
            payload = data;
        }

        this[clientSym].batchCstm(this[eventKeySym], uid, payload);
    }
}

module.exports = GIOEvent;
