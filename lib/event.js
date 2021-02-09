const eventKeySym = Symbol('event');
const clientSym = Symbol('client');
const definitionSym = Symbol('definition');

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
    constructor (gio, eventKey, options) {
        this[clientSym] = gio;
        this[eventKeySym] = eventKey;
        options = Object.assign(
            {
                strict: true,
                transformBeforeValidate: true,
                requiredKeys: [],
            },
            options,
        );
        this.strict = options.strict;
        this.transformBeforeValidate = options.transformBeforeValidate;
        this.requiredKeys = options.requiredKeys;
    }

    async init () {
        const def = await this[clientSym].getEvent(this[eventKeySym]);
        this[definitionSym] = def;
        this.paramsTree = {};
        def.attrs.forEach(attr => {
            const { type, key } = attr;
            this.paramsTree[key] = {
                type,
                validate: (val) => validator[type](key, val, this.strict),
                transforme: (val) => transformer[type](val),
                isRequired: this.requiredKeys.includes(key),
            };
        });
    }

    batch (uid, data) {
        if (!data) {
            throw new TypeError(`Expect \`data\` to not be empty.`);
        }
        const payload = {};
        const keys = Object.keys(data);
        const unassignedRequiredKeys = this.requiredKeys.filter(key => !keys.includes(key));
        if (unassignedRequiredKeys.length) {
            throw new Error(`Params \`${unassignedRequiredKeys.join(', ')}\` are required.`);
        }

        keys.forEach(key => {
            const definition = this.paramsTree[key];
            if (this.strict && !definition) {
                throw new TypeError(`Unexpected params key \`${key}\`.`);
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

        this[clientSym].batchCstm(this[eventKeySym], uid, payload);
    }
}

module.exports = GIOEvent;
