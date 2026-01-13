#ifndef JAR_WORLD_H
#define JAR_WORLD_H

#include <godot_cpp/classes/node3d.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

using namespace godot;

class JarWorld : public Node3D
{
    GDCLASS(JarWorld, Node3D);

  private:
    float gravity_strength = 9.8f;
    float mass = 1.0f;

  public:
    virtual ~JarWorld() = default;

    float get_gravity_strength() const { return gravity_strength; }
    void set_gravity_strength(const float value) { gravity_strength = value; }

    float get_mass() const { return mass; }
    void set_mass(const float value) { mass = value; }

    //inputs are assumed to be in local space
    virtual Vector3 get_gravity_vector(const Vector3 &position) const = 0;
    virtual float get_height(const Vector3 &position) const = 0;

  protected:
    static void _bind_methods()
    {
        ClassDB::bind_method(D_METHOD("get_gravity_strength"), &JarWorld::get_gravity_strength);
        ClassDB::bind_method(D_METHOD("set_gravity_strength", "value"), &JarWorld::set_gravity_strength);
        ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "gravity_strength"), "set_gravity_strength", "get_gravity_strength");

        ClassDB::bind_method(D_METHOD("get_mass"), &JarWorld::get_mass);
        ClassDB::bind_method(D_METHOD("set_mass", "value"), &JarWorld::set_mass);
        ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "mass"), "set_mass", "get_mass");
    }
};

#endif // JAR_WORLD_H
