import file("./collide-variant.arr") as MA
import file("./collide-fun.arr") as MB
# Both `wrap`s reachable through their own alias despite the flat namespace:
print(MB.wrap(5))   # the FUNCTION  -> 105
print(MA.wrap(7))   # the VARIANT   -> wrap(7)
