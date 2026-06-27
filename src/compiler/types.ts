// WASM-GC type definitions for the Pyret runtime value model.
//
// Universal Pyret value = anyref. Concrete representations:
//   - Number tower: $Num (abstract base, tag field) with subtypes
//       $Fixnum   (tag, i64)            exact integer in i64 range
//       $Rational (tag, i64 num, i64 den)  exact rational (den>0, reduced)
//       $Roughnum (tag, f64)            IEEE double (~ literals)
//     (Bignum limbs come in Phase B as another $Num subtype.)
//   - Booleans / nothing: i31ref small immediates (see runtime.ts tags).
//   - Strings, objects, functions, data variants: added incrementally.

import binaryen from "binaryen";

// All features EXCEPT CustomDescriptors (bit 21), which makes binaryen emit
// exact reference types that JavaScriptCore/browsers don't yet accept.
export const FEATURES = binaryen.Features.All & ~(1 << 21);

export const NUM_TAG = {
  FIX: 0,
  RATIONAL: 1,
  ROUGH: 2,
  BIGNUM: 3,
} as const;

export interface RtTypes {
  Num: binaryen.HeapType;
  NumRef: binaryen.Type; // (ref $Num) non-null
  NumRefNull: binaryen.Type;
  Fixnum: binaryen.HeapType;
  FixnumRef: binaryen.Type;
  Rational: binaryen.HeapType;
  RationalRef: binaryen.Type;
  Roughnum: binaryen.HeapType;
  RoughnumRef: binaryen.Type;
  // Bignum: arbitrary-precision integer (sign + i32 limb array, little-endian)
  Bignum: binaryen.HeapType;
  BignumRef: binaryen.Type;
  Limbs: binaryen.HeapType;
  LimbsRef: binaryen.Type;
  // Strings: immutable UTF-8 bytes as a GC array of i8.
  Str: binaryen.HeapType;
  StrRef: binaryen.Type;
  StrRefNull: binaryen.Type;
  // data variants: $Variant { variantId, name, fields } ; $Fields = array anyref
  Fields: binaryen.HeapType;
  FieldsRef: binaryen.Type;
  FieldsRefNull: binaryen.Type;
  Variant: binaryen.HeapType;
  VariantRef: binaryen.Type;
  VariantRefNull: binaryen.Type;
  // closures: $Closure { i32 fnIndex, (ref null $Fields) caps }
  Closure: binaryen.HeapType;
  ClosureRef: binaryen.Type;
  ClosureRefNull: binaryen.Type;
  // objects: $Object { names:(ref $Names), values:(ref $Fields) }; $Names=array (ref $Str)
  Names: binaryen.HeapType;
  NamesRef: binaryen.Type;
  Object: binaryen.HeapType;
  ObjectRef: binaryen.Type;
  ObjectRefNull: binaryen.Type;
  Method: binaryen.HeapType;
  MethodRef: binaryen.Type;
  MethodRefNull: binaryen.Type;
}

export function buildTypes(): RtTypes {
  // $Limbs = (array (mut i32)) — bignum magnitude limbs, little-endian.
  const lb = new binaryen.TypeBuilder(1);
  lb.setArrayType(0, binaryen.i32, binaryen.notPacked, true);
  const limbsHt = lb.buildAndDispose()[0]!;
  const limbsRef = binaryen.getTypeFromHeapType(limbsHt, false);

  const tb = new binaryen.TypeBuilder(5);
  tb.createRecGroup(0, 5);

  const I32 = { type: binaryen.i32, packedType: binaryen.notPacked, mutable: false };
  const I64 = { type: binaryen.i64, packedType: binaryen.notPacked, mutable: false };
  const F64 = { type: binaryen.f64, packedType: binaryen.notPacked, mutable: false };
  const LIMBS = { type: limbsRef, packedType: binaryen.notPacked, mutable: false };

  // 0: $Num — abstract base, just the tag.
  tb.setStructType(0, [I32]);
  tb.setOpen(0);
  const NUMREF = { type: tb.getTempRefType(tb.getTempHeapType(0), false), packedType: binaryen.notPacked, mutable: false };
  // 1: $Fixnum
  tb.setStructType(1, [I32, I64]);
  tb.setSubType(1, tb.getTempHeapType(0));
  // 2: $Rational — exact rational with integer ($Num) numerator/denominator
  tb.setStructType(2, [I32, NUMREF, NUMREF]);
  tb.setSubType(2, tb.getTempHeapType(0));
  // 3: $Roughnum
  tb.setStructType(3, [I32, F64]);
  tb.setSubType(3, tb.getTempHeapType(0));
  // 4: $Bignum — tag, sign (-1/+1), magnitude limbs
  tb.setStructType(4, [I32, I32, LIMBS]);
  tb.setSubType(4, tb.getTempHeapType(0));

  const hts = tb.buildAndDispose();
  const ht = (i: number) => hts[i]!;
  const ref = (i: number) => binaryen.getTypeFromHeapType(hts[i]!, false);
  const refn = (i: number) => binaryen.getTypeFromHeapType(hts[i]!, true);

  // $Str: (array (mut i8)) in its own rec group.
  const sb = new binaryen.TypeBuilder(1);
  sb.setArrayType(0, binaryen.i32, binaryen.i8, true);
  const strHts = sb.buildAndDispose();
  const strHt = strHts[0]!;
  const strRef = binaryen.getTypeFromHeapType(strHt, false);

  // $Fields, $Variant, $Closure rec group.
  const vb = new binaryen.TypeBuilder(3);
  vb.createRecGroup(0, 3);
  vb.setArrayType(0, binaryen.anyref, binaryen.notPacked, true);
  const fieldsRefNTemp = vb.getTempRefType(vb.getTempHeapType(0), true);
  vb.setStructType(1, [
    { type: binaryen.i32, packedType: binaryen.notPacked, mutable: false }, // variantId
    { type: strRef, packedType: binaryen.notPacked, mutable: false },        // name
    { type: fieldsRefNTemp, packedType: binaryen.notPacked, mutable: false }, // fields
  ]);
  vb.setStructType(2, [
    { type: binaryen.i32, packedType: binaryen.notPacked, mutable: false }, // fnIndex
    { type: fieldsRefNTemp, packedType: binaryen.notPacked, mutable: false }, // caps
  ]);
  const vHts = vb.buildAndDispose();
  const fieldsHt = vHts[0]!;
  const variantHt = vHts[1]!;
  const closureHt = vHts[2]!;
  const fieldsRef = binaryen.getTypeFromHeapType(fieldsHt, false);
  const closureRef = binaryen.getTypeFromHeapType(closureHt, false);

  // $Names (array (ref $Str)), $Object, $Method rec group.
  const ob = new binaryen.TypeBuilder(3);
  ob.createRecGroup(0, 3);
  ob.setArrayType(0, strRef, binaryen.notPacked, false);
  ob.setStructType(1, [
    { type: ob.getTempRefType(ob.getTempHeapType(0), false), packedType: binaryen.notPacked, mutable: false }, // names
    { type: fieldsRef, packedType: binaryen.notPacked, mutable: false },  // values
  ]);
  ob.setStructType(2, [
    { type: closureRef, packedType: binaryen.notPacked, mutable: false }, // method closure
  ]);
  const oHts = ob.buildAndDispose();
  const namesHt = oHts[0]!, objectHt = oHts[1]!, methodHt = oHts[2]!;

  return {
    Num: ht(0),
    NumRef: ref(0),
    NumRefNull: refn(0),
    Fixnum: ht(1),
    FixnumRef: ref(1),
    Rational: ht(2),
    RationalRef: ref(2),
    Roughnum: ht(3),
    RoughnumRef: ref(3),
    Bignum: ht(4),
    BignumRef: ref(4),
    Limbs: limbsHt,
    LimbsRef: limbsRef,
    Str: strHt,
    StrRef: strRef,
    StrRefNull: binaryen.getTypeFromHeapType(strHt, true),
    Fields: fieldsHt,
    FieldsRef: binaryen.getTypeFromHeapType(fieldsHt, false),
    FieldsRefNull: binaryen.getTypeFromHeapType(fieldsHt, true),
    Variant: variantHt,
    VariantRef: binaryen.getTypeFromHeapType(variantHt, false),
    VariantRefNull: binaryen.getTypeFromHeapType(variantHt, true),
    Closure: closureHt,
    ClosureRef: closureRef,
    ClosureRefNull: binaryen.getTypeFromHeapType(closureHt, true),
    Names: namesHt,
    NamesRef: binaryen.getTypeFromHeapType(namesHt, false),
    Object: objectHt,
    ObjectRef: binaryen.getTypeFromHeapType(objectHt, false),
    ObjectRefNull: binaryen.getTypeFromHeapType(objectHt, true),
    Method: methodHt,
    MethodRef: binaryen.getTypeFromHeapType(methodHt, false),
    MethodRefNull: binaryen.getTypeFromHeapType(methodHt, true),
  };
}
