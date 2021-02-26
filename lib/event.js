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
    if (val === null) {
        return;
    }
    const tp = getType(val);
    if (typeof val === 'undefined') {
        if (strict) {
            throw new TypeError(`Expect variable \`${key}\` to not be undefined.`);
        }
        return;
    }
    if (typeof expectTypes === 'string') {
        expectTypes = [expectTypes];
    }
    if (!expectTypes.includes(tp)) {
        throw new TypeError(`Expect variable \`${key}\` to be one type of ${expectTypes.join(', ')}, got ${tp}`);
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
            console.log(`Load definitions of event "${def.id}[${def.key}] (${def.attrs.length} vars)" successfully.`);
            this[definitionSym] = def;
            def.attrs.forEach(attr => {
                const { type, key } = attr;
                this.paramsTree[key] = {
                    type,
                    validate: (val) => validator[type](key, val, this.strict),
                    transform: (val) => {
                        return transformer[type](val);
                    },
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

    batch (uid, data, time = Date.now()) {
        if (!data) {
            throw new TypeError(`Expect \`data\` to not be empty.`);
        }
        this.init().catch(err => console.error(`Initialize event poster "${this[eventKeySym]}" failed with error: ${err}`));
        let payload = {};
        const keys = Object.keys(data).filter(key => typeof data[key] !== 'undefined');
        const unassignedRequiredKeys = this.requiredKeys.filter(key => !keys.includes(key));
        if (unassignedRequiredKeys.length) {
            throw new Error(`Params \`${unassignedRequiredKeys.join(', ')}\` are required.`);
        }

        if (this[definitionSym]) {
            Object.keys(this.paramsTree).forEach(key => {
                const definition = this.paramsTree[key];
                if (!definition) {
                    return;
                }
                let val = data[key];
                if (typeof val === 'undefined') {
                    val = null;
                }

                if (val !== null && this.transformBeforeValidate) {
                    val = definition.transform(val);
                }
                definition.validate(val);
                payload[key] = val;
            });
        } else {
            keys.forEach(key => {
                payload[key] = typeof data[key] === 'undefined' ? null : data[key];
            });
        }

        this[clientSym].batchCstm(this[eventKeySym], uid, payload, time);
    }
}

module.exports = GIOEvent;
